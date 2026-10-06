import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';

export const invoicesRouter = Router();

const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ISSUED', 'VOID'],
  ISSUED: ['PAID', 'VOID'],
  PAID: ['VOID'],
  VOID: [],
};

const INVOICE_SELECT = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         b.booking_number, q.quotation_number, l.lead_number,
         w.name AS worker_name, cb.name AS created_by_name,
         CASE WHEN i.booking_id IS NOT NULL
           THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                          WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
           ELSE i.paid_amount END AS live_paid_amount
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN bookings b ON b.id = i.booking_id
  LEFT JOIN quotations q ON q.id = i.quotation_id
  LEFT JOIN leads l ON l.id = i.lead_id
  LEFT JOIN users w ON w.id = i.worker_id
  LEFT JOIN users cb ON cb.id = i.created_by`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function shapeInvoice(row: Record<string, any>): Record<string, any> {
  const total = Number(row.total_amount ?? 0);
  const paid = Number(row.live_paid_amount ?? row.paid_amount ?? 0);
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    booking_id: row.booking_id ?? null,
    booking_number: row.booking_number ?? null,
    quotation_id: row.quotation_id ?? null,
    quotation_number: row.quotation_number ?? null,
    lead_id: row.lead_id ?? null,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_email: row.customer_email ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id ?? null,
    worker_name: row.worker_name ?? null,
    issue_date: row.issue_date,
    due_date: row.due_date ?? null,
    items: parseJson<Array<Record<string, any>>>(row.items, []),
    currency: row.currency ?? 'INR',
    subtotal: Number(row.subtotal ?? 0),
    tax_rate: Number(row.tax_rate ?? 0),
    tax_amount: Number(row.tax_amount ?? 0),
    total_amount: total,
    paid_amount: paid,
    balance_due: round2(total - paid),
    status: row.status,
    notes: row.notes ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function canWrite(req: Parameters<typeof currentUser>[0], invoice: Record<string, any>): boolean {
  if (can(req, 'invoices:manage')) return true;
  if (!can(req, 'invoices:update_own')) return false;
  const user = currentUser(req);
  return invoice.worker_id === user.id || invoice.created_by === user.id;
}

async function loadInvoice(id: number, req: Parameters<typeof currentUser>[0]): Promise<Record<string, any>> {
  const row = await get<Record<string, any>>(
    `SELECT i.*, c.name AS customer_name,
            CASE WHEN i.booking_id IS NOT NULL
              THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                             WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
              ELSE i.paid_amount END AS live_paid_amount
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.id = ? AND i.deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound('Invoice not found.');
  if (!can(req, 'invoices:read_all') && row.worker_id !== currentUser(req).id && row.created_by !== currentUser(req).id) {
    throw notFound('Invoice not found.');
  }
  return row;
}

/* -------------------------------- LIST -------------------------------- */

invoicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    if (!can(req, 'invoices:read_all') && !can(req, 'invoices:read_own')) throw forbidden();

    const where: string[] = ['i.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!can(req, 'invoices:read_all')) {
      where.push('(i.worker_id = ? OR i.created_by = ?)');
      params.push(user.id, user.id);
    }

    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`i.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const bookingId = Number(req.query.booking_id);
    if (bookingId) {
      where.push('i.booking_id = ?');
      params.push(bookingId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push('i.customer_id = ?');
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, 'invoices:read_all')) {
      where.push('i.worker_id = ?');
      params.push(workerId);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(`(i.invoice_number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR b.booking_number LIKE ? ESCAPE '\\')`);
      const term = await likeTerm(search);
      params.push(term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );
    if (dates.from) {
      where.push('i.issue_date >= ?');
      params.push(dates.from);
    }
    if (dates.to) {
      where.push('i.issue_date <= ?');
      params.push(dates.to);
    }

    const sortMap: Record<string, string> = {
      recent: 'i.created_at DESC',
      oldest: 'i.created_at ASC',
      amount: 'i.total_amount DESC',
      due: 'i.due_date IS NULL, i.due_date ASC',
    };
    const orderSql = sortMap[String(req.query.sort ?? 'recent')] ?? sortMap.recent;

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN bookings b ON b.id = i.booking_id ${whereSql}`,
      params,
    ))!.c;
    const rows = await all(`${INVOICE_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const shaped = rows.map(shapeInvoice);
    const totalsRow = (await get<{ total_amount: number; paid_amount: number }>(
      `SELECT COALESCE(SUM(i.total_amount), 0) AS total_amount,
              COALESCE(SUM(CASE WHEN i.booking_id IS NOT NULL
                THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                               WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
                ELSE i.paid_amount END), 0) AS paid_amount
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN bookings b ON b.id = i.booking_id ${whereSql}`,
      params,
    ))!;
    const totals = {
      total_amount: round2(Number(totalsRow.total_amount ?? 0)),
      paid_amount: round2(Number(totalsRow.paid_amount ?? 0)),
      balance_due: round2(Number(totalsRow.total_amount ?? 0) - Number(totalsRow.paid_amount ?? 0)),
      count: total,
    };
    list(res, shaped, { ...buildMeta(page, limit, total), totals });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- GET ONE ------------------------------ */

invoicesRouter.get('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const row = await get<Record<string, any>>(`${INVOICE_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`, [
      Number(req.params.id),
    ]);
    if (!row) throw notFound('Invoice not found.');
    if (
      !can(req, 'invoices:read_all') &&
      row.worker_id !== currentUser(req).id &&
      row.created_by !== currentUser(req).id
    ) {
      throw notFound('Invoice not found.');
    }
    ok(res, shapeInvoice(row));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- CREATE ------------------------------ */

const itemSchema = z.object({
  description: z.string().trim().min(1, 'Item description is required').max(300),
  qty: z.number().min(0.01).max(100000).default(1),
  unit_price: z.number().min(0).max(1_000_000_000),
});

const createSchema = z.object({
  customer_id: z.number().int().positive('Customer is required'),
  booking_id: z.number().int().positive().optional().nullable(),
  quotation_id: z.number().int().positive().optional().nullable(),
  lead_id: z.number().int().positive().optional().nullable(),
  worker_id: z.number().int().positive().optional().nullable(),
  issue_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Issue date must be YYYY-MM-DD')
    .default(() => todayStr()),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must be YYYY-MM-DD')
    .optional()
    .nullable(),
  items: z.array(itemSchema).min(1, 'Add at least one line item').max(200),
  tax_rate: z.number().min(0).max(100).default(0),
  currency: z.string().trim().max(8).default('INR'),
  notes: z.string().trim().max(4000).optional().nullable(),
});

invoicesRouter.post('/', requireAuth, requirePermission('invoices:create'), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    const user = currentUser(req);

    const customer = await get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [
      body.customer_id,
    ]);
    if (!customer) throw badRequest('Customer not found.');

    let currency = body.currency;
    let workerId = body.worker_id ?? null;

    if (body.booking_id) {
      const booking = await get<{ id: number; customer_id: number; worker_id: number | null; currency: string; booking_number: string }>(
        'SELECT id, customer_id, worker_id, currency, booking_number FROM bookings WHERE id = ? AND deleted_at IS NULL',
        [body.booking_id],
      );
      if (!booking) throw badRequest('Booking not found.');
      if (booking.customer_id !== body.customer_id) {
        throw badRequest('The invoice customer must match the booking customer.');
      }
      if (!can(req, 'bookings:read_all') && booking.worker_id !== user.id) {
        throw forbidden();
      }
      currency = booking.currency;
      workerId = workerId ?? booking.worker_id;
    }

    if (body.quotation_id) {
      const quotation = await get<{ id: number; customer_id: number; worker_id: number | null }>(
        'SELECT id, customer_id, worker_id FROM quotations WHERE id = ? AND deleted_at IS NULL',
        [body.quotation_id],
      );
      if (!quotation) throw badRequest('Quotation not found.');
      if (quotation.customer_id !== body.customer_id) {
        throw badRequest('The invoice customer must match the quotation customer.');
      }
      workerId = workerId ?? quotation.worker_id;
    }

    if (body.lead_id) {
      const lead = await get<{ id: number }>('SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL', [body.lead_id]);
      if (!lead) throw badRequest('Lead not found.');
    }

    const subtotal = round2(body.items.reduce((sum, it) => sum + it.qty * it.unit_price, 0));
    const taxAmount = round2((subtotal * body.tax_rate) / 100);
    const total = round2(subtotal + taxAmount);
    const now = await nowISO();
    const stamp = body.issue_date.replace(/-/g, '');
    let invoiceNumber = '';

    const invoiceId = await tx(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const row = await get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM invoices WHERE invoice_number LIKE ?`,
          [`INV-${stamp}-%`],
        );
        const candidate = `INV-${stamp}-${String((row?.n ?? 0) + 1 + attempt).padStart(4, '0')}`;
        if (!await get('SELECT id FROM invoices WHERE invoice_number = ?', [candidate])) {
          invoiceNumber = candidate;
          break;
        }
      }
      if (!invoiceNumber) invoiceNumber = `INV-${stamp}-${Date.now().toString().slice(-6)}`;

      const newId = Number(
        (await run(
          `INSERT INTO invoices (invoice_number, booking_id, quotation_id, lead_id, customer_id, worker_id,
            issue_date, due_date, items, currency, subtotal, tax_rate, tax_amount, total_amount, paid_amount,
            status, notes, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT', ?, ?, ?, ?, ?)`,
          [
            invoiceNumber,
            body.booking_id ?? null,
            body.quotation_id ?? null,
            body.lead_id ?? null,
            body.customer_id,
            workerId,
            body.issue_date,
            body.due_date ?? null,
            JSON.stringify(body.items),
            currency,
            subtotal,
            body.tax_rate,
            taxAmount,
            total,
            body.notes ?? null,
            user.id,
            user.id,
            now,
            now,
          ],
        )).lastInsertRowid,
      );
      await audit(req, 'INVOICE_CREATED', 'invoice', newId, {
        invoice_number: invoiceNumber,
        total_amount: total,
        booking_id: body.booking_id ?? null,
      });
      return newId;
    });

    const row = await get<Record<string, any>>(`${INVOICE_SELECT} WHERE i.id = ?`, [invoiceId]);
    created(res, row ? shapeInvoice(row) : { id: invoiceId, invoice_number: invoiceNumber });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- UPDATE ------------------------------ */

const updateSchema = z.object({
  customer_id: z.number().int().positive().optional(),
  booking_id: z.number().int().positive().optional().nullable(),
  quotation_id: z.number().int().positive().optional().nullable(),
  lead_id: z.number().int().positive().optional().nullable(),
  worker_id: z.number().int().positive().optional().nullable(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  items: z.array(itemSchema).min(1).max(200).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

invoicesRouter.patch('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    if (!canWrite(req, invoice)) throw forbidden();
    if (invoice.status !== 'DRAFT') {
      throw conflict('Only draft invoices can be edited. Revert the status or create a new invoice.');
    }
    const body = meta(updateSchema, req.body);
    if (!Object.keys(body).length) throw badRequest('No changes supplied.');

    let items = parseJson<Array<Record<string, any>>>(invoice.items, []);
    let taxRate = Number(invoice.tax_rate ?? 0);
    if (body.items) items = body.items;
    if (body.tax_rate !== undefined) taxRate = body.tax_rate;

    const subtotal = round2(items.reduce((sum: number, it: any) => sum + Number(it.qty ?? 1) * Number(it.unit_price ?? 0), 0));
    const taxAmount = round2((subtotal * taxRate) / 100);
    const total = round2(subtotal + taxAmount);
    const alreadyPaid = Number(invoice.live_paid_amount ?? invoice.paid_amount ?? 0);
    if (total < alreadyPaid) {
      throw conflict('Total cannot be less than the amount already paid.');
    }

    const user = currentUser(req);
    await run(
      `UPDATE invoices SET customer_id = ?, booking_id = ?, quotation_id = ?, lead_id = ?, worker_id = ?,
         issue_date = ?, due_date = ?, items = ?, tax_rate = ?, subtotal = ?, tax_amount = ?, total_amount = ?,
         notes = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        body.customer_id ?? invoice.customer_id,
        body.booking_id !== undefined ? body.booking_id : invoice.booking_id,
        body.quotation_id !== undefined ? body.quotation_id : invoice.quotation_id,
        body.lead_id !== undefined ? body.lead_id : invoice.lead_id,
        body.worker_id !== undefined ? body.worker_id : invoice.worker_id,
        body.issue_date ?? invoice.issue_date,
        body.due_date !== undefined ? body.due_date : invoice.due_date,
        JSON.stringify(items),
        taxRate,
        subtotal,
        taxAmount,
        total,
        body.notes !== undefined ? body.notes : invoice.notes,
        user.id,
        await nowISO(),
        id,
      ],
    );
    await audit(req, 'INVOICE_UPDATED', 'invoice', id, { changed: Object.keys(body), total_amount: total });

    const row = await get<Record<string, any>>(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
    ok(res, row ? shapeInvoice(row) : null);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ STATUS ------------------------------- */

const statusSchema = z.object({ status: z.enum(INVOICE_STATUSES) });

invoicesRouter.patch('/:id(\\d+)/status', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    if (!canWrite(req, invoice)) throw forbidden();
    const body = meta(statusSchema, req.body);
    const allowed = TRANSITIONS[invoice.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`An invoice cannot move from ${invoice.status} to ${body.status}.`);
    }

    await run('UPDATE invoices SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      body.status,
      currentUser(req).id,
      await nowISO(),
      id,
    ]);
    await audit(req, 'INVOICE_STATUS_CHANGED', 'invoice', id, {
      from: invoice.status,
      to: body.status,
      invoice_number: invoice.invoice_number,
    });

    const row = await get<Record<string, any>>(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
    ok(res, row ? shapeInvoice(row) : null);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- DELETE ------------------------------ */

invoicesRouter.delete('/:id(\\d+)', requireAuth, requirePermission('invoices:manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    const now = await nowISO();
    await run('UPDATE invoices SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    await audit(req, 'INVOICE_DELETED', 'invoice', id, { invoice_number: invoice.invoice_number });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
