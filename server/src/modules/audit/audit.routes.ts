import { Router } from 'express';
import { all, get, likeTerm } from '../../db/database.js';
import { buildMeta, list, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates } from '../../lib/dates.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

export const auditRouter = Router();

auditRouter.get('/audit-logs', requireAuth, requirePermission('audit:read'), (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25, 200);
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];

    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(
        `(a.action LIKE ? ESCAPE '\\' OR a.entity LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`,
      );
      const term = likeTerm(search);
      params.push(term, term, term, term);
    }

    const actions = toArray(req.query.action);
    if (actions.length) {
      where.push(`a.action IN (${actions.map(() => '?').join(',')})`);
      params.push(...actions);
    }
    const entities = toArray(req.query.entity);
    if (entities.length) {
      where.push(`a.entity IN (${entities.map(() => '?').join(',')})`);
      params.push(...entities);
    }
    const userId = Number(req.query.user_id);
    if (userId) {
      where.push('a.user_id = ?');
      params.push(userId);
    }

    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );
    if (dates.from) {
      where.push('a.created_at >= ?');
      params.push(`${dates.from}T00:00:00.000Z`);
    }
    if (dates.to) {
      where.push('a.created_at < ?');
      params.push(`${dates.to}T00:00:00.000Z`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`,
      params,
    )!.c;

    const rows = all(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.ip, a.created_at,
              u.id AS user_id, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    list(
      res,
      rows.map((r: any) => ({ ...r, metadata: safeParse(r.metadata) })),
      buildMeta(page, limit, total),
    );
  } catch (err) {
    next(err);
  }
});

auditRouter.get('/audit-logs/actions', requireAuth, requirePermission('audit:read'), (_req, res, next) => {
  try {
    const rows = all<{ action: string; c: number }>(
      'SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC',
    );
    ok(res, rows.map((r) => ({ action: r.action, count: Number(r.c) })));
  } catch (err) {
    next(err);
  }
});

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
