import { Router } from 'express';
import { all, get, nowISO, run } from '../../db/database.js';
import { notFound } from '../../lib/errors.js';
import { buildMeta, list, ok, pagination } from '../../lib/http.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const unreadOnly = String(req.query.unread ?? '') === '1';
    const where = ['n.user_id = ?'];
    const params: unknown[] = [user.id];
    if (unreadOnly) where.push('n.read_at IS NULL');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications n ${whereSql}`, params)!.c;
    const unread = get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [
      user.id,
    ])!.c;
    const rows = all(
      `SELECT n.* FROM notifications n ${whereSql} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    list(res, rows, { ...buildMeta(page, limit, total), unread });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read-all', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const result = run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [
      nowISO(),
      user.id,
    ]);
    ok(res, { updated: result.changes });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/:id/read', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    const row = get('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [id, user.id]);
    if (!row) throw notFound('Notification not found.');
    run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', [nowISO(), id]);
    ok(res, { read: true });
  } catch (err) {
    next(err);
  }
});
