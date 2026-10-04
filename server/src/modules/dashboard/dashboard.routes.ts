import { Router } from 'express';
import { all, get } from '../../db/database.js';
import { forbidden } from '../../lib/errors.js';
import { ok } from '../../lib/http.js';
import { addDays, resolvePeriodDates, sqlLocalDate, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { effectiveFuStatus } from '../leads/leads.service.js';

export const dashboardRouter = Router();

const TERMINAL_SQL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;

function dimensionFilters(req: any, alias = 'l'): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const workerId = Number(req.query.worker_id);
  if (workerId) {
    where.push(`${alias}.assigned_to = ?`);
    params.push(workerId);
  }
  const sourceId = Number(req.query.source_id);
  if (sourceId) {
    where.push(`${alias}.source_id = ?`);
    params.push(sourceId);
  }
  const statusCodes = String(req.query.status ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (statusCodes.length) {
    where.push(`s.code IN (${statusCodes.map(() => '?').join(',')})`);
    params.push(...statusCodes);
  }
  const destination = String(req.query.destination ?? '').trim();
  if (destination) {
    where.push(`${alias}.destination LIKE ? ESCAPE '\\'`);
    params.push(`%${destination.replace(/[%_]/g, (m: string) => `\\${m}`)}%`);
  }
  return { where, params };
}

/** GET /api/dashboard/admin — team-wide KPIs, charts and action lists. */
dashboardRouter.get('/admin', requireAuth, requirePermission('dashboard:admin'), (req, res, next) => {
  try {
    const today = todayStr();
    const dims = dimensionFilters(req);
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );

    const baseWhere = ['l.deleted_at IS NULL', ...dims.where];
    const baseParams = [...dims.params];
    if (dates.from) {
      baseWhere.push('l.created_at >= ?');
      baseParams.push(`${dates.from}T00:00:00.000Z`);
    }
    if (dates.to) {
      baseWhere.push('l.created_at < ?');
      baseParams.push(`${addDays(dates.to, 1)}T00:00:00.000Z`);
    }
    const whereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';

    const totals = get<any>(
      `SELECT
        COUNT(*) AS total_leads,
        SUM(CASE WHEN s.code = 'NEW' THEN 1 ELSE 0 END) AS new_leads,
        SUM(CASE WHEN l.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned_leads,
        SUM(CASE WHEN l.assigned_to IS NOT NULL THEN 1 ELSE 0 END) AS assigned_leads,
        SUM(CASE WHEN s.category = 'WON' THEN 1 ELSE 0 END) AS conversions,
        SUM(CASE WHEN s.code = 'NOT_INTERESTED' THEN 1 ELSE 0 END) AS not_interested,
        SUM(CASE WHEN s.category = 'OPEN' THEN 1 ELSE 0 END) AS open_leads
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       ${whereSql}`,
      baseParams,
    )!;

    const followUpWhere = ['f.deleted_at IS NULL', 'l.deleted_at IS NULL'];
    const followUpParams: unknown[] = [];
    if (req.query.worker_id) {
      followUpWhere.push('f.worker_id = ?');
      followUpParams.push(Number(req.query.worker_id));
    }
    if (dates.from) {
      followUpWhere.push('f.scheduled_date >= ?');
      followUpParams.push(dates.from);
    }
    if (dates.to) {
      followUpWhere.push('f.scheduled_date <= ?');
      followUpParams.push(dates.to);
    }
    const fuWhereSql = `WHERE ${followUpWhere.join(' AND ')}`;

    const fuCounts = get<any>(
      `SELECT
        SUM(CASE WHEN f.scheduled_date = '${today}' AND f.status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS todays_follow_ups,
        SUM(CASE WHEN f.scheduled_date < '${today}' AND f.status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS overdue_follow_ups,
        COUNT(*) AS total_follow_ups
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       ${fuWhereSql}`,
      followUpParams,
    )!;

    const activeWorkers = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = 'WORKER' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
    )!.c;

    const callScope = req.query.worker_id ? 'AND cl.worker_id = ?' : '';
    const callParams = req.query.worker_id ? [Number(req.query.worker_id)] : [];
    const callsToday = get<any>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN cl.status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN cl.status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
              COALESCE(SUM(cl.duration_seconds), 0) AS seconds
       FROM calls cl
       WHERE cl.deleted_at IS NULL AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) = '${today}' ${callScope}`,
      callParams,
    )!;

    const pipeline = get<any>(
      `SELECT
         (SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL AND status NOT IN ('ACCEPTED','REJECTED','CANCELLED','EXPIRED')) AS open_quotations,
         (SELECT COALESCE(SUM(total_amount), 0) FROM quotations
            WHERE deleted_at IS NULL AND status NOT IN ('ACCEPTED','REJECTED','CANCELLED','EXPIRED')) AS open_quotation_amount,
         (SELECT COUNT(*) FROM bookings WHERE deleted_at IS NULL AND status NOT IN ('CANCELLED','COMPLETED')) AS active_bookings,
         (SELECT COALESCE(SUM(total_amount - paid_amount), 0) FROM bookings WHERE deleted_at IS NULL AND status != 'CANCELLED') AS outstanding_amount,
         (SELECT COALESCE(SUM(paid_amount), 0) FROM bookings WHERE deleted_at IS NULL AND status != 'CANCELLED') AS collected_amount`,
    )!;

    const recentCalls = all(
      `SELECT cl.id, cl.lead_id, cl.direction, cl.status, cl.phone_number, cl.started_at, cl.duration_seconds,
              cl.recording_available, l.lead_number, c.name AS customer_name, u.name AS worker_name
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN users u ON u.id = cl.worker_id
       WHERE cl.deleted_at IS NULL
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 6`,
    );

    const leadsByStatus = all(
      `SELECT s.code, s.name, s.color, s.category, COUNT(*) AS count
       FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       ${whereSql} GROUP BY s.id ORDER BY s.sort_order`,
      baseParams,
    );

    const leadsBySource = all(
      `SELECT COALESCE(src.name, 'Unknown') AS name, COUNT(*) AS count
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       ${whereSql} GROUP BY src.id ORDER BY count DESC LIMIT 12`,
      baseParams,
    );

    const trendFrom = dates.from ? dates.from : addDays(today, -13);
    const trendTo = dates.to ? dates.to : today;
    const trendWhere = [...dims.where, 'l.deleted_at IS NULL', 'l.created_at >= ?', 'l.created_at < ?'];
    const trendParams = [
      ...dims.params,
      `${trendFrom}T00:00:00.000Z`,
      `${addDays(trendTo, 1)}T00:00:00.000Z`,
    ];
    const trendRows = all<{ d: string; c: number }>(
      `SELECT ${sqlLocalDate('l.created_at')} AS d, COUNT(*) AS c
       FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       WHERE ${trendWhere.join(' AND ')} GROUP BY d`,
      trendParams,
    );

    const trend: Array<{ date: string; count: number }> = [];
    const trendMap = new Map(trendRows.map((r) => [r.d, Number(r.c)]));
    let cursor = trendFrom;
    let guard = 0;
    while (cursor <= trendTo && guard < 400) {
      trend.push({ date: cursor, count: trendMap.get(cursor) ?? 0 });
      cursor = addDays(cursor, 1);
      guard += 1;
    }

    const fuOutcomes = all(
      `SELECT ${effectiveFuStatus('f.status', 'f.scheduled_date').sql.replace(/\?/g, `'${today}'`)} AS status, COUNT(*) AS count
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       ${fuWhereSql} GROUP BY status ORDER BY count DESC`,
      followUpParams,
    );

    const recentLeads = all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.created_at, l.budget, l.currency,
              c.name AS customer_name, s.code AS status_code, s.name AS status_name, s.color AS status_color,
              u.name AS assignee_name
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN users u ON u.id = l.assigned_to
       ${whereSql} ORDER BY l.created_at DESC LIMIT 8`,
      baseParams,
    );

    const listFuSelect = `
      SELECT f.id, f.lead_id, f.scheduled_date, f.scheduled_time, f.status, f.type, f.next_action,
             l.lead_number, l.destination, l.priority AS lead_priority,
             c.name AS customer_name, c.phone AS customer_phone, u.name AS worker_name
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id
      JOIN customers c ON c.id = l.customer_id
      JOIN users u ON u.id = f.worker_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL AND f.status NOT IN ${TERMINAL_SQL}`;

    const todaysFollowUps = all(`${listFuSelect} AND f.scheduled_date = '${today}' ORDER BY f.scheduled_time ASC LIMIT 8`);
    const overdueFollowUps = all(`${listFuSelect} AND f.scheduled_date < '${today}' ORDER BY f.scheduled_date ASC LIMIT 8`);

    const unassigned = all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.created_at,
              c.name AS customer_name, s.code AS status_code, s.color AS status_color, src.name AS source_name
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       WHERE l.deleted_at IS NULL AND l.assigned_to IS NULL
       ORDER BY l.created_at ASC LIMIT 8`,
    );

    ok(res, {
      totals: {
        total_leads: Number(totals.total_leads ?? 0),
        new_leads: Number(totals.new_leads ?? 0),
        unassigned_leads: Number(totals.unassigned_leads ?? 0),
        assigned_leads: Number(totals.assigned_leads ?? 0),
        open_leads: Number(totals.open_leads ?? 0),
        conversions: Number(totals.conversions ?? 0),
        not_interested: Number(totals.not_interested ?? 0),
        todays_follow_ups: Number(fuCounts.todays_follow_ups ?? 0),
        overdue_follow_ups: Number(fuCounts.overdue_follow_ups ?? 0),
        total_follow_ups: Number(fuCounts.total_follow_ups ?? 0),
        active_workers: activeWorkers,
        calls_today: Number(callsToday.total ?? 0),
        calls_connected_today: Number(callsToday.connected ?? 0),
        calls_missed_today: Number(callsToday.missed ?? 0),
        open_quotations: Number(pipeline.open_quotations ?? 0),
        open_quotation_amount: Number(pipeline.open_quotation_amount ?? 0),
        active_bookings: Number(pipeline.active_bookings ?? 0),
        outstanding_amount: Number(pipeline.outstanding_amount ?? 0),
        collected_amount: Number(pipeline.collected_amount ?? 0),
      },
      charts: {
        leads_by_status: leadsByStatus.map((r: any) => ({
          code: r.code,
          name: r.name,
          color: r.color,
          category: r.category,
          count: Number(r.count),
        })),
        leads_by_source: leadsBySource.map((r: any) => ({ name: r.name, count: Number(r.count) })),
        leads_trend: trend,
        follow_up_outcomes: fuOutcomes.map((r: any) => ({ status: r.status, count: Number(r.count) })),
      },
      lists: {
        recent_leads: recentLeads,
        todays_follow_ups: todaysFollowUps,
        overdue_follow_ups: overdueFollowUps,
        unassigned_leads: unassigned,
        recent_calls: recentCalls,
      },
      filters: { dates, today },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/dashboard/worker — the "what do I do next?" screen. */
dashboardRouter.get('/worker', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    if (!can(req, 'dashboard:worker') && !can(req, 'dashboard:admin')) throw forbidden();
    const workerId = can(req, 'dashboard:admin') && req.query.worker_id ? Number(req.query.worker_id) : user.id;
    const today = todayStr();

    const stats = get<any>(
      `SELECT
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL
             AND s.category = 'OPEN'
             AND (
               l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date = '${today}')
               OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
               OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
             )) AS today_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN') AS pending_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category IN ('WON','LOST')) AS completed_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'WON') AS converted,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.code = 'NOT_INTERESTED') AS not_interested,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date = '${today}' AND status NOT IN ${TERMINAL_SQL}) AS today_follow_ups,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date < '${today}' AND status NOT IN ${TERMINAL_SQL}) AS overdue_follow_ups,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND status IN ('COMPLETED','CONVERTED')) AS completed_follow_ups`,
      [workerId, workerId, workerId, workerId, workerId, workerId, workerId, workerId, workerId],
    )!;

    const todayLeads = all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.budget, l.currency, l.travel_start_date,
              l.next_follow_up_at, l.created_at, c.name AS customer_name, c.phone AS customer_phone,
              s.code AS status_code, s.name AS status_name, s.color AS status_color,
              (SELECT MIN(f.scheduled_date) FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL
                 AND f.status NOT IN ${TERMINAL_SQL}) AS next_fu_date
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN'
         AND (
           l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date = '${today}')
           OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
           OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
         )
       ORDER BY CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.created_at DESC
       LIMIT 12`,
      [workerId, workerId],
    );

    const followUpSelect = `
      SELECT f.id, f.lead_id, f.scheduled_date, f.scheduled_time, f.status, f.type, f.next_action,
             l.lead_number, l.destination, l.priority AS lead_priority,
             c.name AS customer_name, c.phone AS customer_phone, u.name AS worker_name
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id
      JOIN customers c ON c.id = l.customer_id
      JOIN users u ON u.id = f.worker_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL AND f.worker_id = ? AND f.status NOT IN ${TERMINAL_SQL}`;

    const todaysFollowUps = all(`${followUpSelect} AND f.scheduled_date = '${today}' ORDER BY f.scheduled_time ASC LIMIT 10`, [
      workerId,
    ]);
    const overdueFollowUps = all(
      `${followUpSelect} AND f.scheduled_date < '${today}' ORDER BY f.scheduled_date ASC LIMIT 10`,
      [workerId],
    );

    const activity = all(
      `SELECT t.id, t.type, t.summary, t.created_at, t.lead_id, l.lead_number, c.name AS customer_name
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL
       ORDER BY t.created_at DESC LIMIT 12`,
      [workerId],
    );

    const myCalls = get<any>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed
       FROM calls
       WHERE worker_id = ? AND deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) = '${today}'`,
      [workerId],
    )!;

    const todayCalls = all(
      `SELECT cl.id, cl.lead_id, cl.direction, cl.status, cl.phone_number, cl.started_at, cl.duration_seconds,
              l.lead_number, c.name AS customer_name
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       WHERE cl.worker_id = ? AND cl.deleted_at IS NULL
         AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) = '${today}'
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 6`,
      [workerId],
    );

    ok(res, {
      stats: {
        today_leads: Number(stats.today_leads ?? 0),
        pending_leads: Number(stats.pending_leads ?? 0),
        completed: Number(stats.completed_leads ?? 0),
        converted: Number(stats.converted ?? 0),
        not_interested: Number(stats.not_interested ?? 0),
        today_follow_ups: Number(stats.today_follow_ups ?? 0),
        overdue_follow_ups: Number(stats.overdue_follow_ups ?? 0),
        completed_follow_ups: Number(stats.completed_follow_ups ?? 0),
        calls_today: Number(myCalls.total ?? 0),
        calls_connected_today: Number(myCalls.connected ?? 0),
        calls_missed_today: Number(myCalls.missed ?? 0),
      },
      lists: {
        today_leads: todayLeads,
        today_follow_ups: todaysFollowUps,
        overdue_follow_ups: overdueFollowUps,
        recent_activity: activity,
        today_calls: todayCalls,
      },
      filters: { today },
    });
  } catch (err) {
    next(err);
  }
});
