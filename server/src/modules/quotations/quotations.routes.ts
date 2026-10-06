import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { loadLead, changeLeadStatus } from '../leads/leads.service.js';
import { BOOKING_SELECT, shapeBooking } from '../bookings/bookings.routes.js';

export const quotationsRouter = Router();

const QUOTE_STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'NEGOTIATION', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['VIEWED', 'NEGOTIATION', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  VIEWED: ['NEGOTIATION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  NEGOTIATION: ['SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['CANCELLED'],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const QUOT_SELECT = `
  SELECT q.*, l.lead_number, c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name, cb.name AS created_by_name, ub.name AS updated_by_name
  FROM quotations q
  JOIN leads l ON l.id = q.lead_id
  JOIN customers c ON c.id = q.customer_id
  LEFT JOIN users w ON w.id = q.worker_id
  LEFT JOIN users cb ON cb.id = q.created_by
  LEFT JOIN users ub ON ub.id = q.updated_by`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function shapeQuotation(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    quotation_number: row.quotation_number,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    destination: row.destination ?? null,
    travel_start_date: row.travel_start_date ?? null,
    travel_end_date: row.travel_end_date ?? null,
    travelers: row.travelers ?? null,
    accommodation: row.accommodation ?? null,
    transport: row.transport ?? null,
    activities: row.activities ?? null,
    inclusions: parseJson<string[]>(row.inclusions, []),
    exclusions: parseJson<string[]>(row.exclusions, []),
    items: parseJson<Array<Record<string, any>>>(row.items, []),
    currency: row.currency ?? 'INR',
    total_amount: Number(row.total_amount ?? 0),
    notes: row.notes ?? null,
    valid_until: row.valid_until ?? null,
    status: row.status,
    status_history: parseJson<Array<Record<string, any>>>(row.status_history, []),
    sent_at: row.sent_at ?? null,
    accepted_at: row.accepted_at ?? null,
    rejected_at: row.rejected_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    updated_by_name: row.updated_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface QuotationRow {
  id: number;
  lead_id: number;
  customer_id: number;
  worker_id: number | null;
  created_by: number | null;
  status: string;
  [key: string]: any;
}

async function loadQuotation(id: number, req: any): Promise<QuotationRow> {
  const row = await get<QuotationRow>('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) throw notFound('Quotation not found.');
  const user = req.user;
  if (!user) throw forbidden();
  if (
    !user.permissions.includes('quotations:read_all') &&
    row.worker_id !== user.id &&
    row.created_by !== user.id
  ) {
    throw forbidden('You do not have access to this quotation.');
  }
  return row;
}

function assertQuotationWrite(q: QuotationRow, req: any): void {
  const user = req.user!;
  if (user.permissions.includes('quotations:manage')) return;
  if (!user.permissions.includes('quotations:update_own')) throw forbidden('You cannot modify quotations.');
  if (q.worker_id !== user.id && q.created_by !== user.id) {
    throw forbidden('You can only modify quotations you own.');
  }
}

async function nextQuotationNumber(): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const pattern = `QT-${stamp}-%`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await get<{ n: number }>(
      `SELECT COALESCE(MAX(CAST(substr(quotation_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM quotations WHERE quotation_number LIKE ?`,
      [`QT-${stamp}-`, pattern],
    );
    const candidate = `QT-${stamp}-${String((row?.n ?? 0) + 1 + attempt).padStart(4, '0')}`;
    if (!await get('SELECT id FROM quotations WHERE quotation_number = ?', [candidate])) return candidate;
  }
  return `QT-${stamp}-${Date.now().toString().slice(-6)}`;
}

const itemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().min(0).max(100000).default(1),
  unit_price: z.number().min(0).max(1_000_000_000).default(0),
  amount: z.number().min(0).max(1_000_000_000).optional(),
});

const createSchema = z.object({
  lead_id: z.number().int().positive(),
  worker_id: z.number().int().positive().optional().nullable(),
  destination: z.string().trim().max(160).optional().nullable(),
  travel_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z.number().int().min(1).max(999).optional().nullable(),
  accommodation: z.string().trim().max(500).optional().nullable(),
  transport: z.string().trim().max(500).optional().nullable(),
  activities: z.string().trim().max(1000).optional().nullable(),
  inclusions: z.array(z.string().trim().max(300)).max(100).default([]),
  exclusions: z.array(z.string().trim().max(300)).max(100).default([]),
  items: z.array(itemSchema).max(200).default([]),
  currency: z.string().trim().max(8).default('INR'),
  notes: z.string().trim().max(4000).optional().nullable(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

function totalFromItems(items: z.infer<typeof itemSchema>[]): number {
  return items.reduce((sum, it) => sum + (it.amount ?? it.quantity * it.unit_price), 0);
}

/* -------------------------------- LIST -------------------------------- */

quotationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!can(req, 'quotations:read_all') && !can(req, 'quotations:read_own')) throw forbidden();
    const user = currentUser(req);
    const where: string[] = ['q.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!can(req, 'quotations:read_all')) {
      where.push('(q.worker_id = ? OR q.created_by = ?)');
      params.push(user.id, user.id);
    }

    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`q.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push('q.lead_id = ?');
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push('q.customer_id = ?');
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, 'quotations:read_all')) {
      where.push('q.worker_id = ?');
      params.push(workerId);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(
        `(q.quotation_number LIKE ? ESCAPE '\\' OR q.destination LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\')`,
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );
    if (dates.from) {
      where.push('substr(q.created_at, 1, 10) >= ?');
      params.push(dates.from);
    }
    if (dates.to) {
      where.push('substr(q.created_at, 1, 10) <= ?');
      params.push(dates.to);
    }

    const sortMap: Record<string, string> = {
      recent: 'q.created_at DESC',
      oldest: 'q.created_at ASC',
      amount: 'q.total_amount DESC',
      valid: 'q.valid_until IS NULL, q.valid_until ASC',
    };
    const orderSql = sortMap[String(req.query.sort ?? 'recent')] ?? sortMap.recent;

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM quotations q
         JOIN customers c ON c.id = q.customer_id
         JOIN leads l ON l.id = q.lead_id ${whereSql}`,
      params,
    ))!.c;
    const rows = await all(`${QUOT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeQuotation), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- CREATE ------------------------------ */

quotationsRouter.post('/', requireAuth, requirePermission('quotations:create'), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    const user = currentUser(req);
    const lead = await loadLead(body.lead_id, req);

    let workerId = body.worker_id ?? lead.assigned_to ?? user.id;
    if (workerId !== user.id && !can(req, 'quotations:manage')) {
      if (!lead.assigned_to || workerId !== lead.assigned_to) {
        throw forbidden('You can only create quotations on leads assigned to you.');
      }
    }
    const worker = await get<{ status: string }>('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL', [workerId]);
    if (!worker) throw badRequest('Selected worker does not exist.');

    const now = await nowISO();
    const id = (await run(
      `INSERT INTO quotations (quotation_number, lead_id, customer_id, worker_id, destination, travel_start_date,
        travel_end_date, travelers, accommodation, transport, activities, inclusions, exclusions, items, currency,
        total_amount, notes, valid_until, status, status_history, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', '[]', ?, ?, ?, ?)`,
      [
        await nextQuotationNumber(),
        lead.id,
        lead.customer_id,
        workerId,
        body.destination ?? lead.destination ?? null,
        body.travel_start_date ?? null,
        body.travel_end_date ?? null,
        body.travelers ?? null,
        body.accommodation ?? null,
        body.transport ?? null,
        body.activities ?? null,
        JSON.stringify(body.inclusions),
        JSON.stringify(body.exclusions),
        JSON.stringify(body.items),
        body.currency,
        totalFromItems(body.items),
        body.notes ?? null,
        body.valid_until ?? null,
        user.id,
        user.id,
        now,
        now,
      ],
    )).lastInsertRowid;

    await addTimelineEvent({
      leadId: lead.id,
      type: TIMELINE_TYPES.QUOTATION_CREATED,
      actorId: user.id,
      summary: `Quotation created (${String((await get<{ n: string }>('SELECT quotation_number AS n FROM quotations WHERE id = ?', [id]))!.n)})`,
      metadata: { quotation_id: id, total_amount: totalFromItems(body.items) },
    });
    await audit(req, 'QUOTATION_CREATED', 'quotation', id, { lead_id: lead.id, total: totalFromItems(body.items) });

    if (workerId !== user.id) {
      await notify({
        userId: workerId,
        type: 'QUOTATION_ASSIGNED',
        title: `Quotation prepared for ${lead.lead_number}`,
        body: `${user.name} prepared a quotation for ${lead.destination ?? 'this lead'}.`,
        entity: 'quotation',
        entityId: id,
        link: `/quotations/${id}`,
      });
    }

    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    created(res, shapeQuotation(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DETAIL ------------------------------ */

quotationsRouter.get('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    if (!can(req, 'quotations:read_all') && !can(req, 'quotations:read_own')) throw forbidden();
    const id = Number(req.params.id);
    await loadQuotation(id, req);
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    if (!row) throw notFound('Quotation not found.');
    ok(res, shapeQuotation(row));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- UPDATE ------------------------------ */

const patchSchema = z
  .object({
    destination: z.string().trim().max(160).optional().nullable(),
    travel_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    travel_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    travelers: z.number().int().min(1).max(999).optional().nullable(),
    accommodation: z.string().trim().max(500).optional().nullable(),
    transport: z.string().trim().max(500).optional().nullable(),
    activities: z.string().trim().max(1000).optional().nullable(),
    inclusions: z.array(z.string().trim().max(300)).max(100).optional(),
    exclusions: z.array(z.string().trim().max(300)).max(100).optional(),
    items: z.array(itemSchema).max(200).optional(),
    currency: z.string().trim().max(8).optional(),
    notes: z.string().trim().max(4000).optional().nullable(),
    valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  })
  .partial();

const CLOSED_STATUSES = ['ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

quotationsRouter.patch('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    assertQuotationWrite(q, req);
    if (CLOSED_STATUSES.includes(q.status) && !can(req, 'quotations:manage')) {
      throw conflict(`A ${q.status.toLowerCase()} quotation cannot be edited.`);
    }
    const body = meta(patchSchema, req.body);
    const user = currentUser(req);

    const fields: string[] = [];
    const params: unknown[] = [];
    const allowed = [
      'destination',
      'travel_start_date',
      'travel_end_date',
      'travelers',
      'accommodation',
      'transport',
      'activities',
      'currency',
      'notes',
      'valid_until',
    ] as const;
    for (const key of allowed) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (body.inclusions !== undefined) {
      fields.push('inclusions = ?');
      params.push(JSON.stringify(body.inclusions));
    }
    if (body.exclusions !== undefined) {
      fields.push('exclusions = ?');
      params.push(JSON.stringify(body.exclusions));
    }
    if (body.items !== undefined) {
      fields.push('items = ?');
      params.push(JSON.stringify(body.items));
      fields.push('total_amount = ?');
      params.push(totalFromItems(body.items));
    }
    if (!fields.length) throw badRequest('No changes supplied.');
    fields.push('updated_by = ?', 'updated_at = ?');
    params.push(user.id, await nowISO(), id);
    await run(`UPDATE quotations SET ${fields.join(', ')} WHERE id = ?`, params);

    await audit(req, 'QUOTATION_UPDATED', 'quotation', id, { fields: Object.keys(body) });
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    ok(res, shapeQuotation(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ STATUS ------------------------------- */

const statusSchema = z.object({
  status: z.enum(QUOTE_STATUSES),
  remark: z.string().trim().max(500).optional().nullable(),
});

quotationsRouter.post('/:id(\\d+)/status', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    assertQuotationWrite(q, req);
    const body = meta(statusSchema, req.body);
    const user = currentUser(req);

    if (q.status === body.status) throw conflict('Quotation is already in that status.');
    const allowed = TRANSITIONS[q.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`Cannot move a ${q.status} quotation to ${body.status}.`, { allowed });
    }

    const now = await nowISO();
    const history = parseJson<Array<Record<string, any>>>(q.status_history, []);
    history.push({
      from: q.status,
      to: body.status,
      at: now,
      by: user.id,
      by_name: user.name,
      remark: body.remark ?? null,
    });

    await run(
      `UPDATE quotations SET status = ?, status_history = ?, sent_at = COALESCE(sent_at, ?), accepted_at = ?,
         rejected_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        body.status,
        JSON.stringify(history),
        body.status === 'SENT' ? now : null,
        body.status === 'ACCEPTED' ? now : q.accepted_at,
        body.status === 'REJECTED' ? now : q.rejected_at,
        user.id,
        now,
        id,
      ],
    );

    if (q.lead_id) {
      const type =
        body.status === 'SENT'
          ? TIMELINE_TYPES.QUOTATION_SENT
          : TIMELINE_TYPES.QUOTATION_STATUS_CHANGED;
      await addTimelineEvent({
        leadId: q.lead_id,
        type,
        actorId: user.id,
        summary: `Quotation ${q.status} → ${body.status}${body.remark ? ` (${body.remark})` : ''}`,
        metadata: { quotation_id: id, from: q.status, to: body.status },
      });
    }
    await audit(req, 'QUOTATION_STATUS_CHANGED', 'quotation', id, { from: q.status, to: body.status, remark: body.remark ?? null });

    if (q.worker_id && q.worker_id !== user.id) {
      await notify({
        userId: q.worker_id,
        type: 'QUOTATION_STATUS_CHANGED',
        title: `${q.quotation_number} is now ${body.status}`,
        body: body.remark ?? `${user.name} changed the quotation status.`,
        entity: 'quotation',
        entityId: id,
        link: `/quotations/${id}`,
      });
    }

    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    ok(res, shapeQuotation(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ CONVERT ------------------------------ */

/**
 * Accepted quotation → booking. One click, same data, no re-typing; the lead
 * moves to CONVERTED so the pipeline reflects reality.
 */
quotationsRouter.post('/:id(\\d+)/convert', requireAuth, requirePermission('bookings:create'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    const user = currentUser(req);

    if (q.status !== 'ACCEPTED') throw conflict('Only an accepted quotation can be converted to a booking.');

    let bookingNumber = '';
    const bookingId = await tx(async () => {
      const already = await get<{ id: number; booking_number: string }>(
        'SELECT id, booking_number FROM bookings WHERE quotation_id = ? AND deleted_at IS NULL',
        [id],
      );
      if (already) throw conflict('This quotation has already been converted.', { booking_id: already.id });

      const now = await nowISO();
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = `BK-${stamp}-${String(attempt + 1).padStart(4, '0')}`;
        if (!await get('SELECT id FROM bookings WHERE booking_number = ?', [candidate])) {
          bookingNumber = candidate;
          break;
        }
      }
      if (!bookingNumber) bookingNumber = `BK-${stamp}-${Date.now().toString().slice(-6)}`;

      const newId = Number(
        (await run(
          `INSERT INTO bookings (booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
            travel_start_date, travel_end_date, travelers, currency, total_amount, paid_amount, payment_status,
            status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID', 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?)`,
          [
            bookingNumber,
            q.lead_id,
            q.customer_id,
            q.id,
            q.worker_id,
            q.destination ?? null,
            q.travel_start_date ?? null,
            q.travel_end_date ?? null,
            q.travelers ?? null,
            q.currency ?? 'INR',
            Number(q.total_amount ?? 0),
            JSON.stringify([{ from: 'PENDING', to: 'CONFIRMED', at: now, by: user.id, reason: 'Converted from quotation' }]),
            q.notes ?? null,
            now,
            user.id,
            user.id,
            now,
            now,
          ],
        )).lastInsertRowid,
      );

      if (q.lead_id) {
        await addTimelineEvent({
          leadId: q.lead_id,
          type: TIMELINE_TYPES.BOOKING_CREATED,
          actorId: user.id,
          summary: `Booking ${bookingNumber} created from ${q.quotation_number}`,
          metadata: { booking_id: newId, quotation_id: id },
        });
        const lead = await get<{ status_id: number }>('SELECT status_id FROM leads WHERE id = ?', [q.lead_id]);
        const converted = await get<{ id: number }>(`SELECT id FROM lead_statuses WHERE code = 'CONVERTED'`);
        if (lead && converted && lead.status_id !== converted.id) {
          await changeLeadStatus({
            leadId: q.lead_id,
            toCode: 'CONVERTED',
            actorId: user.id,
            remark: `Booking ${bookingNumber}`,
            silent: true,
          });
        }
      }
      await audit(req, 'BOOKING_CREATED', 'booking', newId, { quotation_id: id, lead_id: q.lead_id, booking_number: bookingNumber });
      return newId;
    });

    if (q.worker_id && q.worker_id !== user.id) {
      await notify({
        userId: q.worker_id,
        type: 'BOOKING_CREATED',
        title: `Booking ${bookingNumber} created`,
        body: `Converted from quotation ${q.quotation_number}.`,
        entity: 'booking',
        entityId: bookingId,
        link: `/bookings/${bookingId}`,
      });
    }

    const row = await get<Record<string, any>>(`${BOOKING_SELECT} WHERE b.id = ?`, [bookingId]);
    created(res, { booking_id: bookingId, booking_number: bookingNumber, data: row ? shapeBooking(row) : null });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- STATS ------------------------------- */

/** Counts per status for list headers and dashboards. */
quotationsRouter.get('/stats/summary', requireAuth, async (req, res, next) => {
  try {
    if (!can(req, 'quotations:read_all') && !can(req, 'quotations:read_own')) throw forbidden();
    const user = currentUser(req);
    const scopeSelf = !can(req, 'quotations:read_all');
    const rows = await all<{ status: string; c: number; amount: number }>(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS amount
       FROM quotations
       WHERE deleted_at IS NULL ${scopeSelf ? 'AND (worker_id = ? OR created_by = ?)' : ''}
       GROUP BY status`,
      scopeSelf ? [user.id, user.id] : [],
    );
    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const r of rows) byStatus[r.status] = { count: Number(r.c), amount: Number(r.amount) };
    const expiring = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM quotations
       WHERE deleted_at IS NULL AND status IN ('SENT','VIEWED','NEGOTIATION')
         AND valid_until IS NOT NULL AND valid_until >= ? AND valid_until <= date('now', '+7 day')
         ${scopeSelf ? 'AND (worker_id = ? OR created_by = ?)' : ''}`,
      scopeSelf ? [todayStr(), user.id, user.id] : [todayStr()],
    ))!.c;
    ok(res, { by_status: byStatus, expiring_in_7_days: expiring });
  } catch (err) {
    next(err);
  }
});
