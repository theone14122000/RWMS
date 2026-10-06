import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { loadLead } from '../leads/leads.service.js';

export const bookingsRouter = Router();

const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

const TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const BOOKING_SELECT = `
  SELECT b.*, l.lead_number, c.name AS customer_name, c.phone AS customer_phone,
         q.quotation_number, w.name AS worker_name, cb.name AS created_by_name, ub.name AS updated_by_name
  FROM bookings b
  LEFT JOIN leads l ON l.id = b.lead_id
  JOIN customers c ON c.id = b.customer_id
  LEFT JOIN quotations q ON q.id = b.quotation_id
  LEFT JOIN users w ON w.id = b.worker_id
  LEFT JOIN users cb ON cb.id = b.created_by
  LEFT JOIN users ub ON ub.id = b.updated_by`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function shapeBooking(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    booking_number: row.booking_number,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    quotation_id: row.quotation_id ?? null,
    quotation_number: row.quotation_number ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    destination: row.destination ?? null,
    travel_start_date: row.travel_start_date ?? null,
    travel_end_date: row.travel_end_date ?? null,
    travelers: row.travelers ?? null,
    services: parseJson<Array<Record<string, any>>>(row.services, []),
    currency: row.currency ?? 'INR',
    total_amount: Number(row.total_amount ?? 0),
    paid_amount: Number(row.paid_amount ?? 0),
    balance_due: Number(row.total_amount ?? 0) - Number(row.paid_amount ?? 0),
    payment_status: row.payment_status,
    status: row.status,
    status_history: parseJson<Array<Record<string, any>>>(row.status_history, []),
    notes: row.notes ?? null,
    booked_at: row.booked_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    updated_by_name: row.updated_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface BookingRow {
  id: number;
  lead_id: number | null;
  customer_id: number;
  quotation_id: number | null;
  worker_id: number | null;
  created_by: number | null;
  status: string;
  total_amount: number;
  paid_amount: number;
  [key: string]: any;
}

async function loadBooking(id: number, req: any): Promise<BookingRow> {
  const row = await get<BookingRow>('SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) throw notFound('Booking not found.');
  const user = req.user;
  if (!user) throw forbidden();
  if (
    !user.permissions.includes('bookings:read_all') &&
    row.worker_id !== user.id &&
    row.created_by !== user.id
  ) {
    throw forbidden('You do not have access to this booking.');
  }
  return row;
}

function assertBookingWrite(b: BookingRow, req: any): void {
  const user = req.user!;
  if (user.permissions.includes('bookings:manage')) return;
  if (!user.permissions.includes('bookings:update_own')) throw forbidden('You cannot modify bookings.');
  if (b.worker_id !== user.id && b.created_by !== user.id) {
    throw forbidden('You can only modify bookings you own.');
  }
}

async function nextBookingNumber(): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await get<{ n: number }>(
      `SELECT COALESCE(MAX(CAST(substr(booking_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM bookings WHERE booking_number LIKE ?`,
      [`BK-${stamp}-`, `BK-${stamp}-%`],
    );
    const candidate = `BK-${stamp}-${String((row?.n ?? 0) + 1 + attempt).padStart(4, '0')}`;
    if (!await get('SELECT id FROM bookings WHERE booking_number = ?', [candidate])) return candidate;
  }
  return `BK-${stamp}-${Date.now().toString().slice(-6)}`;
}

/** Recomputes the rolled-up payment fields after any payment change. */
async function recomputePayment(bookingId: number): Promise<void> {
  const booking = await get<{ total_amount: number; currency: string }>(
    'SELECT total_amount, currency FROM bookings WHERE id = ?',
    [bookingId],
  );
  const sums = await get<{ paid: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE booking_id = ? AND deleted_at IS NULL AND currency = ?',
    [bookingId, booking?.currency ?? 'INR'],
  );
  const paid = Number(sums?.paid ?? 0);
  const total = Number(booking?.total_amount ?? 0);
  const paymentStatus = paid <= 0 ? 'UNPAID' : paid + 0.001 >= total ? 'PAID' : 'PARTIAL';
  await run('UPDATE bookings SET paid_amount = ?, payment_status = ?, updated_at = ? WHERE id = ?', [
    paid,
    paymentStatus,
    await nowISO(),
    bookingId,
  ]);
}

/* -------------------------------- LIST -------------------------------- */

bookingsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where: string[] = ['b.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!can(req, 'bookings:read_all')) {
      where.push('(b.worker_id = ? OR b.created_by = ?)');
      params.push(user.id, user.id);
    }

    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`b.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const paymentStatuses = toArray(req.query.payment_status);
    if (paymentStatuses.length) {
      where.push(`b.payment_status IN (${paymentStatuses.map(() => '?').join(',')})`);
      params.push(...paymentStatuses);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push('b.customer_id = ?');
      params.push(customerId);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push('b.lead_id = ?');
      params.push(leadId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, 'bookings:read_all')) {
      where.push('b.worker_id = ?');
      params.push(workerId);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(
        `(b.booking_number LIKE ? ESCAPE '\\' OR b.destination LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR q.quotation_number LIKE ? ESCAPE '\\')`,
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
      where.push('substr(b.created_at, 1, 10) >= ?');
      params.push(dates.from);
    }
    if (dates.to) {
      where.push('substr(b.created_at, 1, 10) <= ?');
      params.push(dates.to);
    }

    const sortMap: Record<string, string> = {
      recent: 'b.created_at DESC',
      oldest: 'b.created_at ASC',
      amount: 'b.total_amount DESC',
      travel: 'b.travel_start_date IS NULL, b.travel_start_date ASC',
    };
    const orderSql = sortMap[String(req.query.sort ?? 'recent')] ?? sortMap.recent;

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         LEFT JOIN quotations q ON q.id = b.quotation_id ${whereSql}`,
      params,
    ))!.c;
    const rows = await all(`${BOOKING_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeBooking), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- CREATE ------------------------------ */

const createSchema = z.object({
  lead_id: z.number().int().positive().optional().nullable(),
  customer_id: z.number().int().positive().optional().nullable(),
  quotation_id: z.number().int().positive().optional().nullable(),
  worker_id: z.number().int().positive().optional().nullable(),
  destination: z.string().trim().max(160).optional().nullable(),
  travel_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z.number().int().min(1).max(999).optional().nullable(),
  services: z
    .array(z.object({ name: z.string().trim().min(1).max(200), amount: z.number().min(0).optional() }))
    .max(100)
    .default([]),
  currency: z.string().trim().max(8).default('INR'),
  total_amount: z.number().min(0).max(1_000_000_000).default(0),
  notes: z.string().trim().max(4000).optional().nullable(),
  status: z.enum(BOOKING_STATUSES).default('PENDING'),
});

bookingsRouter.post('/', requireAuth, requirePermission('bookings:create'), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    const user = currentUser(req);

    let leadId = body.lead_id ?? null;
    let customerId = body.customer_id ?? null;
    let workerId = body.worker_id ?? null;
    let quotationId = body.quotation_id ?? null;
    let destination = body.destination ?? null;
    let travelStart = body.travel_start_date ?? null;
    let travelEnd = body.travel_end_date ?? null;
    let travelers = body.travelers ?? null;
    let total = body.total_amount;
    let currency = body.currency;

    if (quotationId) {
      const existing = await get<{ id: number }>(
        'SELECT id FROM bookings WHERE quotation_id = ? AND deleted_at IS NULL',
        [quotationId],
      );
      if (existing) throw conflict('A booking already exists for this quotation.');
      const q = await get<any>('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL', [quotationId]);
      if (!q) throw notFound('Quotation not found.');
      if (
        !can(req, 'quotations:read_all') &&
        q.worker_id !== user.id &&
        q.created_by !== user.id
      ) {
        throw forbidden('You do not have access to that quotation.');
      }
      leadId = leadId ?? q.lead_id;
      customerId = customerId ?? q.customer_id;
      workerId = workerId ?? q.worker_id;
      destination = destination ?? q.destination;
      travelStart = travelStart ?? q.travel_start_date;
      travelEnd = travelEnd ?? q.travel_end_date;
      travelers = travelers ?? q.travelers;
      // The quotation total is authoritative — never accept a client total for it.
      total = Number(q.total_amount ?? 0);
      currency = currency || q.currency || 'INR';
    } else if (leadId) {
      const lead = await loadLead(leadId, req);
      customerId = customerId ?? lead.customer_id;
      workerId = workerId ?? lead.assigned_to ?? user.id;
      destination = destination ?? lead.destination ?? null;
    }

    if (!customerId) throw badRequest('A customer (or lead, or quotation) is required.');
    const customer = await get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [customerId]);
    if (!customer) throw notFound('Customer not found.');

    if (workerId && workerId !== user.id && !can(req, 'bookings:manage') && workerId !== (leadId ? (await loadLead(leadId, req)).assigned_to : null)) {
      throw forbidden('You cannot create bookings for another worker.');
    }
    if (!workerId) workerId = user.id;
    const worker = await get<{ status: string }>('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL', [workerId]);
    if (!worker) throw badRequest('Selected worker does not exist.');
    if (worker.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');

    // Without a quotation, an itemised booking's total is summed server-side.
    if (!quotationId && body.services.length > 0) {
      total = body.services.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
    }

    const now = await nowISO();
    const bookingId = await tx(async () => {
      const newId = (await run(
      `INSERT INTO bookings (booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
        travel_start_date, travel_end_date, travelers, services, currency, total_amount, paid_amount,
        payment_status, status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        await nextBookingNumber(),
        leadId,
        customerId,
        quotationId,
        workerId,
        destination,
        travelStart,
        travelEnd,
        travelers,
        JSON.stringify(body.services),
        currency,
        total,
        body.status,
        JSON.stringify(
          body.status === 'PENDING'
            ? []
            : [{ from: 'PENDING', to: body.status, at: now, by: user.id, reason: 'Created in this status' }],
        ),
        body.notes ?? null,
        now,
        user.id,
        user.id,
        now,
        now,
      ],
    )).lastInsertRowid;

      if (leadId) {
        await addTimelineEvent({
          leadId,
          type: TIMELINE_TYPES.BOOKING_CREATED,
          actorId: user.id,
          summary: `Booking created (${String((await get<{ n: string }>('SELECT booking_number AS n FROM bookings WHERE id = ?', [Number(newId)]))!.n)})`,
          metadata: { booking_id: Number(newId), total_amount: total },
        });
      }
      await audit(req, 'BOOKING_CREATED', 'booking', Number(newId), {
        customer_id: customerId,
        lead_id: leadId,
        quotation_id: quotationId,
        total_amount: total,
      });
      return Number(newId);
    });

    if (workerId !== user.id) {
      await notify({
        userId: workerId,
        type: 'BOOKING_ASSIGNED',
        title: 'New booking assigned',
        body: `${user.name} created a booking${destination ? ` for ${destination}` : ''}.`,
        entity: 'booking',
        entityId: bookingId,
        link: `/bookings/${bookingId}`,
      });
    }

    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [bookingId]);
    created(res, shapeBooking(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DETAIL ------------------------------ */

bookingsRouter.get('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadBooking(id, req);
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    if (!row) throw notFound('Booking not found.');
    ok(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});

const patchSchema = z
  .object({
    destination: z.string().trim().max(160).optional().nullable(),
    travel_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    travel_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    travelers: z.number().int().min(1).max(999).optional().nullable(),
    services: z
      .array(z.object({ name: z.string().trim().min(1).max(200), amount: z.number().min(0).optional() }))
      .max(100)
      .optional(),
    currency: z.string().trim().max(8).optional(),
    total_amount: z.number().min(0).max(1_000_000_000).optional(),
    notes: z.string().trim().max(4000).optional().nullable(),
  })
  .partial();

bookingsRouter.patch('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const body = meta(patchSchema, req.body);
    const user = currentUser(req);

    const fields: string[] = [];
    const params: unknown[] = [];
    for (const key of ['destination', 'travel_start_date', 'travel_end_date', 'travelers', 'currency', 'notes'] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (body.services !== undefined) {
      fields.push('services = ?');
      params.push(JSON.stringify(body.services));
    }
    if (body.total_amount !== undefined || body.services !== undefined) {
      // Financial totals are derived server-side, never trusted from the client:
      // a linked quotation's total is authoritative; otherwise itemised services
      // are summed; only a manual total on a non-quotation booking is accepted.
      let newTotal: number;
      if (booking.quotation_id) {
        const q = await get<{ total_amount: number }>('SELECT total_amount FROM quotations WHERE id = ?', [
          booking.quotation_id,
        ]);
        newTotal = Number(q?.total_amount ?? booking.total_amount ?? 0);
        if (body.total_amount !== undefined && Math.abs(newTotal - body.total_amount) > 0.001) {
          throw badRequest('Total is derived from the linked quotation and cannot be changed here.');
        }
      } else if (body.services !== undefined && body.services.length > 0) {
        newTotal = body.services.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
      } else if (body.total_amount !== undefined) {
        newTotal = body.total_amount;
      } else {
        newTotal = Number(booking.total_amount ?? 0);
      }
      const current = Number(booking.total_amount ?? 0);
      if (newTotal + 0.001 < Number(booking.paid_amount ?? 0)) {
        throw badRequest('Total cannot be lower than the amount already paid.');
      }
      if (Math.abs(newTotal - current) > 0.001) {
        fields.push('total_amount = ?');
        params.push(newTotal);
        await audit(req, 'BOOKING_TOTAL_CHANGED', 'booking', id, { from: current, to: newTotal });
      }
    }
    if (!fields.length) throw badRequest('No changes supplied.');
    fields.push('updated_by = ?', 'updated_at = ?');
    params.push(user.id, await nowISO(), id);
    await tx(async () => {
      await run(`UPDATE bookings SET ${fields.join(', ')} WHERE id = ?`, params);
      if (fields.some((f) => f.startsWith('total_amount'))) await recomputePayment(id);
    });

    await audit(req, 'BOOKING_UPDATED', 'booking', id, { fields: Object.keys(body) });
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ STATUS ------------------------------- */

const statusSchema = z.object({
  status: z.enum(BOOKING_STATUSES),
  remark: z.string().trim().max(500).optional().nullable(),
});

bookingsRouter.post('/:id(\\d+)/status', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const body = meta(statusSchema, req.body);
    const user = currentUser(req);

    if (booking.status === body.status) throw conflict('Booking is already in that status.');
    const allowed = TRANSITIONS[booking.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`Cannot move a ${booking.status} booking to ${body.status}.`, { allowed });
    }

    const now = await nowISO();
    const history = parseJson<Array<Record<string, any>>>(booking.status_history, []);
    history.push({
      from: booking.status,
      to: body.status,
      at: now,
      by: user.id,
      by_name: user.name,
      remark: body.remark ?? null,
    });
    await run('UPDATE bookings SET status = ?, status_history = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      body.status,
      JSON.stringify(history),
      user.id,
      now,
      id,
    ]);

    if (booking.lead_id) {
      await addTimelineEvent({
        leadId: booking.lead_id,
        type: TIMELINE_TYPES.BOOKING_STATUS_CHANGED,
        actorId: user.id,
        summary: `Booking ${booking.status} → ${body.status}${body.remark ? ` (${body.remark})` : ''}`,
        metadata: { booking_id: id, from: booking.status, to: body.status },
      });
    }
    await audit(req, 'BOOKING_STATUS_CHANGED', 'booking', id, {
      from: booking.status,
      to: body.status,
      remark: body.remark ?? null,
    });

    if (booking.worker_id && booking.worker_id !== user.id) {
      await notify({
        userId: booking.worker_id,
        type: 'BOOKING_STATUS_CHANGED',
        title: `Booking ${booking.booking_number} is now ${body.status}`,
        body: body.remark ?? `${user.name} updated the booking.`,
        entity: 'booking',
        entityId: id,
        link: `/bookings/${id}`,
      });
    }

    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ PAYMENTS ----------------------------- */

function shapePayment(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    booking_id: row.booking_id,
    amount: Number(row.amount ?? 0),
    currency: row.currency ?? 'INR',
    method: row.method ?? null,
    reference: row.reference ?? null,
    status: row.status,
    paid_at: row.paid_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    created_at: row.created_at,
  };
}

bookingsRouter.get('/:id(\\d+)/payments', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadBooking(id, req);
    const rows = await all(
      `SELECT p.*, u.name AS created_by_name FROM payments p
         LEFT JOIN users u ON u.id = p.created_by
       WHERE p.booking_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
      [id],
    );
    list(res, rows.map(shapePayment));
  } catch (err) {
    next(err);
  }
});

const paymentSchema = z.object({
  amount: z.number().positive().max(1_000_000_000),
  currency: z.string().trim().max(8).optional(),
  method: z.string().trim().max(40).optional().nullable(),
  reference: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['RECORDED', 'PENDING', 'CONFIRMED']).default('RECORDED'),
  paid_at: z
    .string()
    .trim()
    .max(40)
    .refine((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), 'paid_at must be a valid date')
    .optional()
    .nullable(),
});

bookingsRouter.post('/:id(\\d+)/payments', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    if (booking.status === 'CANCELLED') throw conflict('Payments cannot be added to a cancelled booking.');
    const body = meta(paymentSchema, req.body);
    const user = currentUser(req);
    const now = await nowISO();

    // Never trust the client on financial totals: cap at the outstanding balance.
    const balance = Number(booking.total_amount ?? 0) - Number(booking.paid_amount ?? 0);
    if (Number(booking.total_amount ?? 0) > 0 && body.amount > balance + 0.001) {
      throw badRequest(
        `Payment exceeds the outstanding balance (${Math.max(balance, 0).toFixed(2)} ${booking.currency ?? 'INR'}).`,
      );
    }

    const paymentId = await tx(async () => {
      const createdId = (await run(
        `INSERT INTO payments (booking_id, amount, currency, method, reference, status, paid_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          body.amount,
          body.currency || booking.currency || 'INR',
          body.method ?? null,
          body.reference ?? null,
          body.status,
          body.paid_at ?? now,
          user.id,
          now,
          now,
        ],
      )).lastInsertRowid;
      await recomputePayment(id);
      return Number(createdId);
    });
    await audit(req, 'PAYMENT_RECORDED', 'payment', paymentId, {
      booking_id: id,
      amount: body.amount,
      method: body.method ?? null,
    });

    if (booking.worker_id && booking.worker_id !== user.id) {
      await notify({
        userId: booking.worker_id,
        type: 'PAYMENT_RECORDED',
        title: `Payment recorded for ${booking.booking_number}`,
        body: `${body.currency || booking.currency || 'INR'} ${body.amount.toFixed(2)} recorded.`,
        entity: 'booking',
        entityId: id,
        link: `/bookings/${id}`,
      });
    }

    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    created(res, { payment_id: paymentId, booking: shapeBooking(row!) });
  } catch (err) {
    next(err);
  }
});

bookingsRouter.delete('/:id(\\d+)/payments/:paymentId(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const paymentId = Number(req.params.paymentId);
    const payment = await get<{ id: number }>(
      'SELECT id FROM payments WHERE id = ? AND booking_id = ? AND deleted_at IS NULL',
      [paymentId, id],
    );
    if (!payment) throw notFound('Payment not found.');

    await tx(async () => {
      await run('UPDATE payments SET deleted_at = ?, updated_at = ? WHERE id = ?', [await nowISO(), await nowISO(), paymentId]);
      await recomputePayment(id);
    });
    await audit(req, 'PAYMENT_VOIDED', 'payment', paymentId, { booking_id: id });

    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row!));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- STATS ------------------------------- */

bookingsRouter.get('/stats/summary', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const scopeSelf = !can(req, 'bookings:read_all');
    const rows = await all<{ status: string; c: number; amount: number; paid: number }>(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS amount, COALESCE(SUM(paid_amount), 0) AS paid
       FROM bookings
       WHERE deleted_at IS NULL ${scopeSelf ? 'AND (worker_id = ? OR created_by = ?)' : ''}
       GROUP BY status`,
      scopeSelf ? [user.id, user.id] : [],
    );
    const byStatus: Record<string, { count: number; amount: number; paid: number }> = {};
    for (const r of rows) {
      byStatus[r.status] = { count: Number(r.c), amount: Number(r.amount), paid: Number(r.paid) };
    }
    const payment = (await get<{ unpaid: number; partial: number; paid: number }>(
      `SELECT
         SUM(CASE WHEN payment_status = 'UNPAID' THEN 1 ELSE 0 END) AS unpaid,
         SUM(CASE WHEN payment_status = 'PARTIAL' THEN 1 ELSE 0 END) AS partial,
         SUM(CASE WHEN payment_status = 'PAID' THEN 1 ELSE 0 END) AS paid
       FROM bookings WHERE deleted_at IS NULL ${scopeSelf ? 'AND (worker_id = ? OR created_by = ?)' : ''}`,
      scopeSelf ? [user.id, user.id] : [],
    ))!;
    ok(res, {
      by_status: byStatus,
      payment: { unpaid: Number(payment.unpaid ?? 0), partial: Number(payment.partial ?? 0), paid: Number(payment.paid ?? 0) },
    });
  } catch (err) {
    next(err);
  }
});
