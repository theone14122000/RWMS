import { Router } from 'express';
import { all, get } from '../../db/database.js';
import { notFound } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { todayStr } from '../../lib/dates.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

export const analyticsRouter = Router();

function periodWindow(query: unknown): { from: string; to: string; granularity: 'day' | 'week' | 'month' } {
  const q = (query ?? {}) as Record<string, unknown>;
  const period = String(q.period ?? '').trim() || 'month';
  const now = new Date();
  const today = todayStr();
  if (period === 'today') return { from: today, to: today, granularity: 'day' };
  if (period === 'week') {
    const day = now.getUTCDay() || 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
    return { from: start.toISOString().slice(0, 10), to: today, granularity: 'day' };
  }
  if (period === 'quarter') {
    const month = Math.floor(now.getUTCMonth() / 3) * 3 + 1;
    return { from: `${now.getUTCFullYear()}-${String(month).padStart(2, '0')}-01`, to: today, granularity: 'day' };
  }
  if (period === 'year') return { from: `${now.getUTCFullYear()}-01-01`, to: today, granularity: 'month' };
  const days = Number(q.days) || 30;
  const start = new Date(now.getTime() - (days - 1) * 86400_000);
  return { from: start.toISOString().slice(0, 10), to: today, granularity: 'day' };
}

/* ------------------------------- OVERVIEW ------------------------------ */

analyticsRouter.get('/overview', requireAuth, requirePermission('analytics:read'), (req, res, next) => {
  try {
    const { from, to, granularity } = periodWindow(req.query);

    const leadsCreated = all<{ bucket: string; c: number }>(
      `SELECT substr(created_at, 1, ${granularity === 'month' ? 7 : 10}) AS bucket, COUNT(*) AS c
       FROM leads WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to],
    );

    const leadsWon = all<{ bucket: string; c: number }>(
      `SELECT substr(h.changed_at, 1, ${granularity === 'month' ? 7 : 10}) AS bucket, COUNT(*) AS c
       FROM lead_status_history h
       JOIN lead_statuses ts ON ts.id = h.to_status_id
       WHERE ts.code = 'CONVERTED' AND substr(h.changed_at, 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to],
    );

    const followUps = all<{ bucket: string; due: number; completed: number }>(
      `SELECT substr(scheduled_date, 1, ${granularity === 'month' ? 7 : 10}) AS bucket,
              COUNT(*) AS due,
              SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed
       FROM follow_ups WHERE scheduled_date BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to],
    );

    const calls = all<{ bucket: string; total: number; connected: number; seconds: number }>(
      `SELECT substr(COALESCE(started_at, created_at), 1, ${granularity === 'month' ? 7 : 10}) AS bucket,
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              COALESCE(SUM(duration_seconds), 0) AS seconds
       FROM calls WHERE deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to],
    );

    const revenue = all<{ bucket: string; amount: number; paid: number; count: number }>(
      `SELECT substr(created_at, 1, 7) AS bucket,
              COALESCE(SUM(total_amount), 0) AS amount,
              COALESCE(SUM(paid_amount), 0) AS paid,
              COUNT(*) AS count
       FROM bookings
       WHERE deleted_at IS NULL AND status != 'CANCELLED'
         AND substr(created_at, 1, 10) BETWEEN date(?, '-365 day') AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to],
    );

    ok(res, {
      period: { from, to, granularity },
      leads_created: leadsCreated.map((r) => ({ bucket: r.bucket, count: Number(r.c) })),
      leads_won: leadsWon.map((r) => ({ bucket: r.bucket, count: Number(r.c) })),
      follow_ups: followUps.map((r) => ({
        bucket: r.bucket,
        due: Number(r.due),
        completed: Number(r.completed),
      })),
      calls: calls.map((r) => ({
        bucket: r.bucket,
        total: Number(r.total),
        connected: Number(r.connected),
        seconds: Number(r.seconds),
      })),
      bookings: revenue.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
        amount: Number(r.amount),
        paid: Number(r.paid),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------- WORKER COMPARISON -------------------------- */

interface WorkerMetrics {
  id: number;
  name: string;
  status: string;
  leads: number;
  leads_converted: number;
  follow_ups_due: number;
  follow_ups_completed: number;
  follow_ups_overdue: number;
  calls: number;
  calls_connected: number;
  call_seconds: number;
  quotations: number;
  quotations_accepted: number;
  bookings: number;
  booking_amount: number;
  booking_paid: number;
}

function metricsFor(workerId: number | null, from: string, to: string): WorkerMetrics | null {
  const leadScope = workerId ? 'AND l.assigned_to = ?' : '';
  const fuScope = workerId ? 'AND f.worker_id = ?' : '';
  const callScope = workerId ? 'AND cl.worker_id = ?' : '';
  const quoteScope = workerId ? 'AND q.worker_id = ?' : '';
  const bookingScope = workerId ? 'AND b.worker_id = ?' : '';
  const p1 = workerId ? [workerId] : [];

  const leads = get<{ total: number; converted: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ls.code = 'CONVERTED' THEN 1 ELSE 0 END) AS converted
     FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
     WHERE l.deleted_at IS NULL AND substr(l.created_at, 1, 10) BETWEEN ? AND ? ${leadScope}`,
    [from, to, ...p1],
  )!;

  const fu = get<{ due: number; completed: number; overdue: number }>(
    `SELECT COUNT(*) AS due,
            SUM(CASE WHEN f.status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED') AND f.scheduled_date < ?
                THEN 1 ELSE 0 END) AS overdue
     FROM follow_ups f
     WHERE f.scheduled_date BETWEEN ? AND ? ${fuScope}`,
    [todayStr(), from, to, ...p1],
  )!;

  const calls = get<{ total: number; connected: number; seconds: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cl.status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
            COALESCE(SUM(cl.duration_seconds), 0) AS seconds
     FROM calls cl
     WHERE cl.deleted_at IS NULL AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) BETWEEN ? AND ? ${callScope}`,
    [from, to, ...p1],
  )!;

  const quotes = get<{ total: number; accepted: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN q.status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted
     FROM quotations q
     WHERE q.deleted_at IS NULL AND substr(q.created_at, 1, 10) BETWEEN ? AND ? ${quoteScope}`,
    [from, to, ...p1],
  )!;

  const bookings = get<{ total: number; amount: number; paid: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(b.total_amount), 0) AS amount, COALESCE(SUM(b.paid_amount), 0) AS paid
     FROM bookings b
     WHERE b.deleted_at IS NULL AND b.status != 'CANCELLED'
       AND substr(b.created_at, 1, 10) BETWEEN ? AND ? ${bookingScope}`,
    [from, to, ...p1],
  )!;

  let name = '';
  let status = 'ACTIVE';
  if (workerId) {
    const user = get<{ name: string; status: string }>('SELECT name, status FROM users WHERE id = ?', [workerId]);
    if (!user) return null;
    name = user.name;
    status = user.status;
  }

  return {
    id: workerId ?? 0,
    name,
    status,
    leads: Number(leads.total ?? 0),
    leads_converted: Number(leads.converted ?? 0),
    follow_ups_due: Number(fu.due ?? 0),
    follow_ups_completed: Number(fu.completed ?? 0),
    follow_ups_overdue: Number(fu.overdue ?? 0),
    calls: Number(calls.total ?? 0),
    calls_connected: Number(calls.connected ?? 0),
    call_seconds: Number(calls.seconds ?? 0),
    quotations: Number(quotes.total ?? 0),
    quotations_accepted: Number(quotes.accepted ?? 0),
    bookings: Number(bookings.total ?? 0),
    booking_amount: Number(bookings.amount ?? 0),
    booking_paid: Number(bookings.paid ?? 0),
  };
}

analyticsRouter.get('/workers', requireAuth, requirePermission('analytics:read'), (req, res, next) => {
  try {
    const { from, to } = periodWindow(req.query);
    const workers = all<{ id: number; name: string; status: string }>(
      `SELECT id, name, status FROM users
       WHERE deleted_at IS NULL AND id != 1
       ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
    );
    const rows = workers
      .map((w) => {
        const m = metricsFor(w.id, from, to);
        return m ? { ...m, name: w.name, status: w.status } : null;
      })
      .filter(Boolean);
    ok(res, { period: { from, to }, workers: rows });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- DRILL-DOWN ------------------------------ */

analyticsRouter.get('/workers/:id(\\d+)', requireAuth, requirePermission('analytics:read'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { from, to } = periodWindow(req.query);
    const worker = get<{ id: number; name: string; email: string | null; status: string; role_id: number }>(
      'SELECT id, name, email, status, role_id FROM users WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    if (!worker) throw notFound('Worker not found.');

    const metrics = metricsFor(id, from, to)!;

    const byLeadStatus = all<{ code: string; name: string; c: number }>(
      `SELECT ls.code, ls.name, COUNT(l.id) AS c
       FROM lead_statuses ls
       LEFT JOIN leads l ON l.status_id = ls.id AND l.deleted_at IS NULL AND l.assigned_to = ?
       WHERE ls.is_active = 1
       GROUP BY ls.id ORDER BY ls.sort_order`,
      [id],
    );

    const upcoming = all(
      `SELECT f.id, f.scheduled_date, f.scheduled_time, f.type, f.status, l.lead_number, l.destination, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE f.worker_id = ? AND f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED')
         AND l.deleted_at IS NULL
       ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 10`,
      [id],
    );

    const recentActivity = all(
      `SELECT t.id, t.type, t.summary, t.created_at, l.lead_number
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       WHERE t.actor_id = ? AND l.deleted_at IS NULL
       ORDER BY t.id DESC LIMIT 20`,
      [id],
    );

    const leadsByDestination = all<{ destination: string | null; c: number }>(
      `SELECT destination, COUNT(*) AS c FROM leads
       WHERE assigned_to = ? AND deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY destination ORDER BY c DESC LIMIT 10`,
      [id, from, to],
    );

    ok(res, {
      period: { from, to },
      worker: { id: worker.id, name: worker.name, email: worker.email, status: worker.status },
      metrics,
      by_lead_status: byLeadStatus.map((r) => ({ code: r.code, name: r.name, count: Number(r.c) })),
      by_destination: leadsByDestination.map((r) => ({ destination: r.destination ?? '(unset)', count: Number(r.c) })),
      upcoming_follow_ups: upcoming,
      recent_activity: recentActivity,
    });
  } catch (err) {
    next(err);
  }
});
