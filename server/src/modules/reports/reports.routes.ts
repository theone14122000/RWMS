import { Router } from 'express';
import { all, get } from '../../db/database.js';
import { notFound } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { todayStr } from '../../lib/dates.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { toCsv } from '../../services/csv.js';
import { audit } from '../../services/audit.js';

export const reportsRouter = Router();

function periodWindow(query: unknown): { from: string; to: string } {
  const q = (query ?? {}) as Record<string, unknown>;
  const from = String(q.date_from ?? '').trim() || undefined;
  const to = String(q.date_to ?? '').trim() || undefined;
  const period = String(q.period ?? '').trim() || 'month';
  if (from || to) return { from: from ?? '1970-01-01', to: to ?? todayStr() };
  const now = new Date();
  if (period === 'today') {
    const d = todayStr();
    return { from: d, to: d };
  }
  if (period === 'week') {
    const day = now.getUTCDay() || 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
    return { from: start.toISOString().slice(0, 10), to: todayStr() };
  }
  if (period === 'year') return { from: `${now.getUTCFullYear()}-01-01`, to: todayStr() };
  // month (default)
  return { from: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, to: todayStr() };
}

/* ------------------------- AGGREGATE SUMMARY ------------------------- */

reportsRouter.get('/summary', requireAuth, requirePermission('reports:read'), async (req, res, next) => {
  try {
    const { from, to } = periodWindow(req.query);
    const dates = [from, to];

    const leadStatusRows = await all<{ code: string; name: string; c: number }>(
      `SELECT ls.code, ls.name, COUNT(l.id) AS c
       FROM lead_statuses ls LEFT JOIN leads l ON l.status_id = ls.id AND l.deleted_at IS NULL
       WHERE ls.is_active = 1
       GROUP BY ls.id ORDER BY ls.sort_order`,
    );
    const totalLeads = leadStatusRows.reduce((s, r) => s + Number(r.c), 0);
    const createdInPeriod = (await get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM leads WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?',
      dates,
    ))!.c;
    const converted = Number(
      leadStatusRows.find((r) => r.code === 'CONVERTED')?.c ?? 0,
    );

    const fu = (await get<{ due: number; completed: number; overdue: number }>(
      `SELECT
         COUNT(*) AS due,
         SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED') AND scheduled_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM follow_ups WHERE scheduled_date BETWEEN ? AND ?`,
      [todayStr(), from, to],
    ))!;

    const calls = (await get<{ total: number; connected: number; missed: number; seconds: number }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
         SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
         COALESCE(SUM(duration_seconds), 0) AS seconds
       FROM calls WHERE deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      dates,
    ))!;

    const quotes = (await get<{ total: number; accepted: number; accepted_amount: number; amount: number }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted,
         COALESCE(SUM(CASE WHEN status = 'ACCEPTED' THEN total_amount ELSE 0 END), 0) AS accepted_amount,
         COALESCE(SUM(total_amount), 0) AS amount
       FROM quotations WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
      dates,
    ))!;

    const bookings = (await get<{ total: number; amount: number; paid: number; outstanding: number }>(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(total_amount), 0) AS amount,
         COALESCE(SUM(paid_amount), 0) AS paid,
         COALESCE(SUM(total_amount - paid_amount), 0) AS outstanding
       FROM bookings
       WHERE deleted_at IS NULL AND status != 'CANCELLED' AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
      dates,
    ))!;

    ok(res, {
      period: { from, to },
      leads: {
        total: totalLeads,
        created_in_period: Number(createdInPeriod),
        converted,
        conversion_rate: totalLeads ? Math.round((converted / totalLeads) * 1000) / 10 : 0,
        by_status: leadStatusRows.map((r) => ({ code: r.code, name: r.name, count: Number(r.c) })),
      },
      follow_ups: {
        due: Number(fu.due ?? 0),
        completed: Number(fu.completed ?? 0),
        overdue: Number(fu.overdue ?? 0),
        completion_rate: Number(fu.due) ? Math.round((Number(fu.completed) / Number(fu.due)) * 1000) / 10 : 0,
      },
      calls: {
        total: Number(calls.total ?? 0),
        connected: Number(calls.connected ?? 0),
        missed: Number(calls.missed ?? 0),
        avg_seconds:
          Number(calls.connected) > 0 ? Math.round(Number(calls.seconds) / Number(calls.connected)) : 0,
      },
      quotations: {
        total: Number(quotes.total ?? 0),
        accepted: Number(quotes.accepted ?? 0),
        amount: Number(quotes.amount ?? 0),
        accepted_amount: Number(quotes.accepted_amount ?? 0),
        conversion_rate: Number(quotes.total) ? Math.round((Number(quotes.accepted) / Number(quotes.total)) * 1000) / 10 : 0,
      },
      bookings: {
        total: Number(bookings.total ?? 0),
        amount: Number(bookings.amount ?? 0),
        paid: Number(bookings.paid ?? 0),
        outstanding: Number(bookings.outstanding ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ EXPORTS ------------------------------ */

type ExportResult = { header: string[]; rows: Array<Record<string, string | number | null>> };
type ExportBuilder = (query: unknown) => ExportResult | Promise<ExportResult>;

/**
 * Every SELECT below aliases its columns to the exact header names so rows can
 * be packed positionally for CSV and rendered by key for the JSON preview.
 */
const EXPORTS: Record<string, ExportBuilder> = {
  leads: async () => ({
    header: [
      'lead_number',
      'customer',
      'phone',
      'destination',
      'status',
      'priority',
      'assigned_to',
      'source',
      'budget',
      'travel_start',
      'travel_end',
      'last_contacted',
      'created_at',
    ],
    rows: await all(
      `SELECT l.lead_number AS lead_number, c.name AS customer, c.phone AS phone,
              l.destination AS destination, ls.code AS status, l.priority AS priority,
              COALESCE(w.name, '') AS assigned_to, COALESCE(src.name, '') AS source,
              l.budget AS budget, l.travel_start_date AS travel_start,
              l.travel_end_date AS travel_end, l.last_contacted_at AS last_contacted,
              l.created_at AS created_at
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses ls ON ls.id = l.status_id
       LEFT JOIN users w ON w.id = l.assigned_to
       LEFT JOIN lead_sources src ON src.id = l.source_id
       WHERE l.deleted_at IS NULL
       ORDER BY l.created_at DESC`,
    ),
  }),
  customers: async () => ({
    header: ['name', 'phone', 'whatsapp', 'email', 'city', 'state', 'country', 'created_at'],
    rows: await all(
      `SELECT name AS name, phone AS phone, whatsapp AS whatsapp, email AS email,
              city AS city, state AS state, country AS country, created_at AS created_at
       FROM customers WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
    ),
  }),
  'follow-ups': async () => ({
    header: ['lead_number', 'customer', 'worker', 'scheduled_date', 'scheduled_time', 'type', 'status', 'next_action', 'notes'],
    rows: await all(
      `SELECT l.lead_number AS lead_number, c.name AS customer, w.name AS worker,
              f.scheduled_date AS scheduled_date, f.scheduled_time AS scheduled_time,
              f.type AS type, f.status AS status,
              COALESCE(f.next_action, '') AS next_action, COALESCE(f.notes, '') AS notes
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       WHERE l.deleted_at IS NULL
       ORDER BY f.scheduled_date DESC, f.scheduled_time DESC`,
    ),
  }),
  calls: async () => ({
    header: ['lead_number', 'customer', 'worker', 'direction', 'phone', 'status', 'duration_seconds', 'started_at', 'disposition', 'recording'],
    rows: await all(
      `SELECT COALESCE(l.lead_number, '') AS lead_number, COALESCE(c.name, '') AS customer,
              COALESCE(w.name, '') AS worker, cl.direction AS direction,
              COALESCE(cl.phone_number, '') AS phone, cl.status AS status,
              cl.duration_seconds AS duration_seconds, cl.started_at AS started_at,
              COALESCE(cl.disposition, '') AS disposition, cl.recording_available AS recording
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN users w ON w.id = cl.worker_id
       WHERE cl.deleted_at IS NULL
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC`,
    ),
  }),
  quotations: async () => ({
    header: ['quotation_number', 'lead_number', 'customer', 'destination', 'status', 'total_amount', 'currency', 'valid_until', 'created_at'],
    rows: await all(
      `SELECT q.quotation_number AS quotation_number, l.lead_number AS lead_number,
              c.name AS customer, COALESCE(q.destination, '') AS destination,
              q.status AS status, q.total_amount AS total_amount, q.currency AS currency,
              COALESCE(q.valid_until, '') AS valid_until, q.created_at AS created_at
       FROM quotations q
       JOIN leads l ON l.id = q.lead_id
       JOIN customers c ON c.id = q.customer_id
       WHERE q.deleted_at IS NULL ORDER BY q.created_at DESC`,
    ),
  }),
  bookings: async () => ({
    header: ['booking_number', 'customer', 'destination', 'status', 'total_amount', 'paid_amount', 'payment_status', 'travel_start', 'created_at'],
    rows: await all(
      `SELECT b.booking_number AS booking_number, c.name AS customer,
              COALESCE(b.destination, '') AS destination, b.status AS status,
              b.total_amount AS total_amount, b.paid_amount AS paid_amount,
              b.payment_status AS payment_status, COALESCE(b.travel_start_date, '') AS travel_start,
              b.created_at AS created_at
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.deleted_at IS NULL ORDER BY b.created_at DESC`,
    ),
  }),
};

/** Packs object rows into positional arrays aligned with the header. */
function packRows(header: string[], rows: Array<Record<string, string | number | null>>): Array<Array<string | number | null>> {
  return rows.map((row) => header.map((key) => row[key] ?? null));
}

reportsRouter.get('/exports/:entity', requireAuth, requirePermission('exports:run'), async (req, res, next) => {
  try {
    const entity = String(req.params.entity).toLowerCase();
    const build = EXPORTS[entity];
    if (!build) throw notFound(`Unknown export entity. Available: ${Object.keys(EXPORTS).join(', ')}`);

    const { header, rows } = await build(req.query);
    const csv = toCsv([header, ...packRows(header, rows)]);
    const stamp = todayStr();
    const filename = `${entity}-${stamp}.csv`;
    await audit(req, 'DATA_EXPORTED', 'export', entity, { entity, rows: rows.length });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/** Same data as the CSV export, as JSON — used by the reports table UI. */
reportsRouter.get('/exports/:entity/preview', requireAuth, requirePermission('reports:read'), async (req, res, next) => {
  try {
    const entity = String(req.params.entity).toLowerCase();
    const build = EXPORTS[entity];
    if (!build) throw notFound(`Unknown export entity. Available: ${Object.keys(EXPORTS).join(', ')}`);
    const { header, rows } = await build(req.query);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    ok(res, {
      entity,
      header,
      rows: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit,
    });
  } catch (err) {
    next(err);
  }
});

export { EXPORTS };
