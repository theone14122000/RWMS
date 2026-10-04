import { Router } from 'express';
import { all, get } from '../../db/database.js';
import { forbidden } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { resolvePeriodDates, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth } from '../../middleware/auth.js';

export const workloadRouter = Router();

const TERMINAL_SQL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;

/**
 * GET /api/workload — daily lead workload per worker.
 * Query: period, date_from, date_to, worker_id
 */
workloadRouter.get('/', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const readAll = can(req, 'leads:read_all') || can(req, 'dashboard:admin');
    if (!readAll && !can(req, 'dashboard:worker')) throw forbidden();

    const today = todayStr();
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );

    const requestedWorker = Number(req.query.worker_id) || undefined;
    const workerId = readAll ? requestedWorker : user.id;

    const where: string[] = ['u.deleted_at IS NULL', "r.code = 'WORKER'"];
    const params: unknown[] = [];
    if (!readAll) {
      where.push('u.id = ?');
      params.push(user.id);
    } else if (workerId) {
      where.push('u.id = ?');
      params.push(workerId);
    }
    const statusFilter = String(req.query.status ?? '').trim();
    if (statusFilter) {
      where.push('u.status = ?');
      params.push(statusFilter);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(`(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
      params.push(`%${search.replace(/[%_]/g, (m: string) => `\\${m}`)}%`);
    }

    const workers = all<{ id: number; name: string; email: string; status: string }>(
      `SELECT u.id, u.name, u.email, u.status
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.name COLLATE NOCASE ASC`,
      params,
    );

    const rows = workers.map((w) => {
      const assignmentWhere: string[] = ['a.assigned_to = ?', 'a.is_active = 1', 'l.deleted_at IS NULL'];
      const assignmentParams: unknown[] = [w.id];
      if (dates.from) {
        assignmentWhere.push('a.assigned_at >= ?');
        assignmentParams.push(`${dates.from}T00:00:00.000Z`);
      }
      if (dates.to) {
        assignmentWhere.push('a.assigned_at < ?');
        assignmentParams.push(`${dates.to}T00:00:00.000Z`);
      }

      const counts = get<any>(
        `SELECT
          COUNT(*) AS assigned,
          SUM(CASE WHEN s.category IN ('WON','LOST') THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN s.category = 'OPEN' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN s.category = 'OPEN' AND (
                l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date < '${today}')
                OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) < '${today}'
              ) THEN 1 ELSE 0 END) AS overdue,
          SUM(CASE WHEN s.category = 'WON' THEN 1 ELSE 0 END) AS converted
         FROM lead_assignments a
         JOIN leads l ON l.id = a.lead_id
         JOIN lead_statuses s ON s.id = l.status_id
         WHERE ${assignmentWhere.join(' AND ')}`,
        assignmentParams,
      )!;

      const fu = get<any>(
        `SELECT
           SUM(CASE WHEN scheduled_date = '${today}' AND status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS today,
           SUM(CASE WHEN scheduled_date < '${today}' AND status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS done
         FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL`,
        [w.id],
      )!;

      return {
        worker_id: w.id,
        name: w.name,
        email: w.email,
        status: w.status,
        assigned: Number(counts.assigned ?? 0),
        completed: Number(counts.completed ?? 0),
        pending: Number(counts.pending ?? 0),
        overdue: Number(counts.overdue ?? 0),
        converted: Number(counts.converted ?? 0),
        follow_ups_today: Number(fu.today ?? 0),
        follow_ups_overdue: Number(fu.overdue ?? 0),
        follow_ups_done: Number(fu.done ?? 0),
      };
    });

    ok(res, {
      period: dates,
      today,
      rows,
      totals: rows.reduce(
        (acc, r) => ({
          assigned: acc.assigned + r.assigned,
          completed: acc.completed + r.completed,
          pending: acc.pending + r.pending,
          overdue: acc.overdue + r.overdue,
          converted: acc.converted + r.converted,
          follow_ups_today: acc.follow_ups_today + r.follow_ups_today,
          follow_ups_overdue: acc.follow_ups_overdue + r.follow_ups_overdue,
        }),
        {
          assigned: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          converted: 0,
          follow_ups_today: 0,
          follow_ups_overdue: 0,
        },
      ),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/workload/today — today's lead queue for a worker (self or any worker for admin).
 */
workloadRouter.get('/today', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const readAll = can(req, 'leads:read_all');
    const requested = Number(req.query.worker_id) || user.id;
    if (!readAll && requested !== user.id) throw forbidden();
    const today = todayStr();

    const rows = all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.travel_start_date, l.budget, l.currency,
              l.created_at, l.next_follow_up_at, c.name AS customer_name, c.phone AS customer_phone,
              s.code AS status_code, s.name AS status_name, s.color AS status_color,
              (SELECT MIN(f.scheduled_date) FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL
                 AND f.status NOT IN ${TERMINAL_SQL}) AS next_fu_date
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND (
         l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date = '${today}')
         OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
         OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
       )
       ORDER BY CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.created_at DESC
       LIMIT 50`,
      [requested, requested],
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});
