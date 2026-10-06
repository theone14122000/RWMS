import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { todayStr } from '../../lib/dates.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { hashPassword } from '../../lib/password.js';
import { currentUser, requireAuth, requirePermission, revokeAllSessions } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';

export const usersRouter = Router();

const WORKER_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;

const createSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().email('Valid email is required').max(200),
  phone: z.string().trim().max(30).optional().nullable(),
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain letters, numbers, dot, underscore and hyphen')
    .optional()
    .nullable(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  role: z.enum(['ADMIN', 'WORKER']).default('WORKER'),
  status: z.enum(WORKER_STATUSES).default('ACTIVE'),
});

const updateSchema = createSchema
  .omit({ password: true })
  .partial()
  .extend({ password: z.string().min(8).max(200).optional() });

const statusSchema = z.object({ status: z.enum(WORKER_STATUSES) });

async function assertUnique(user: { email: string; username?: string | null }, excludeId?: number): Promise<void> {
  const emailRow = await get<{ id: number }>(
    'SELECT id FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL',
    [user.email],
  );
  if (emailRow && emailRow.id !== excludeId) throw conflict('A worker with this email already exists.');

  if (user.username) {
    const usernameRow = await get<{ id: number }>(
      'SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL',
      [user.username],
    );
    if (usernameRow && usernameRow.id !== excludeId) throw conflict('A worker with this username already exists.');
  }
}

function shape(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    username: row.username,
    role: row.role_code,
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lead_count: Number(row.lead_count ?? 0),
    open_lead_count: Number(row.open_lead_count ?? 0),
  };
}

/** GET /api/users — worker directory (admin only). */
usersRouter.get('/', requireAuth, requirePermission('users:manage'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const search = String(req.query.search ?? '').trim();
    const status = toArray(req.query.status);
    const role = toArray(req.query.role);

    const where: string[] = ['u.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (search) {
      where.push('(u.name LIKE ? ESCAPE \'\\\' OR u.email LIKE ? ESCAPE \'\\\' OR u.phone LIKE ? ESCAPE \'\\\' OR u.username LIKE ? ESCAPE \'\\\')');
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    if (status.length) {
      where.push(`u.status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
    }
    if (role.length) {
      where.push(`r.code IN (${role.map(() => '?').join(',')})`);
      params.push(...role);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id ${whereSql}`,
      params,
    ))!.c;

    const rows = await all(
      `SELECT u.id, u.name, u.email, u.phone, u.username, u.status, u.last_login_at, u.created_at, u.updated_at,
              r.code AS role_code,
              (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.deleted_at IS NULL) AS lead_count,
              (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
                WHERE l.assigned_to = u.id AND l.deleted_at IS NULL AND s.category = 'OPEN') AS open_lead_count
       FROM users u JOIN roles r ON r.id = u.role_id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    list(res, rows.map(shape), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/** POST /api/users — create a worker (or another admin). */
usersRouter.post('/', requireAuth, requirePermission('users:manage'), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    await assertUnique(body);

    const role = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', [body.role]);
    if (!role) throw badRequest('Unknown role.');

    const now = await nowISO();
    const result = await tx(async () => {
      const inserted = await run(
        `INSERT INTO users (name, email, phone, username, password_hash, role_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.name,
          body.email.toLowerCase(),
          body.phone ?? null,
          body.username?.toLowerCase() ?? null,
          hashPassword(body.password),
          role.id,
          body.status,
          now,
          now,
        ],
      );
      return inserted.lastInsertRowid;
    });

    await audit(req, 'WORKER_CREATED', 'user', result, {
      name: body.name,
      email: body.email,
      role: body.role,
      status: body.status,
    });

    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [
      result,
    ]);
    created(res, shape(row!));
  } catch (err) {
    next(err);
  }
});

/** GET /api/users/:id — worker profile (admin or self). */
usersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    if (user.role !== 'ADMIN' && user.id !== id) throw forbidden();

    const row = await get<any>(
      `SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw notFound('Worker not found.');

    const today = todayStr();
    const workload = await get<{ total: number; open: number; today_fu: number; overdue_fu: number }>(
      `SELECT
        (SELECT COUNT(*) FROM leads WHERE assigned_to = ? AND deleted_at IS NULL) AS total,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
          WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN') AS open,
        (SELECT COUNT(*) FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date = ?
          AND status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')) AS today_fu,
        (SELECT COUNT(*) FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date < ?
          AND status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')) AS overdue_fu`,
      [id, id, id, today, id, today],
    );

    ok(res, { ...shape(row), permissions: row.role_code === 'ADMIN' ? ['*'] : [], workload });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/users/:id — edit a worker. */
usersRouter.patch('/:id', requireAuth, requirePermission('users:manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get<any>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Worker not found.');

    const body = meta(updateSchema, req.body);
    await assertUnique(
      {
        email: body.email ?? existing.email,
        username: body.username !== undefined ? body.username : existing.username,
      },
      id,
    );

    const now = await nowISO();
    let roleId = existing.role_id;
    if (body.role) {
      const role = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', [body.role]);
      if (!role) throw badRequest('Unknown role.');
      roleId = role.id;
    }

    const nextStatus = body.status ?? existing.status;
    await run(
      `UPDATE users SET name = ?, email = ?, phone = ?, username = ?, role_id = ?, status = ?,
        password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
      [
        body.name ?? existing.name,
        (body.email ?? existing.email).toLowerCase(),
        body.phone !== undefined ? body.phone : existing.phone,
        body.username !== undefined ? (body.username ? body.username.toLowerCase() : null) : existing.username,
        roleId,
        nextStatus,
        body.password ? hashPassword(body.password) : null,
        now,
        id,
      ],
    );

    if (nextStatus !== 'ACTIVE' || body.password || roleId !== existing.role_id) {
      await revokeAllSessions(id);
    }

    await audit(req, 'WORKER_UPDATED', 'user', id, {
      changed: Object.keys(body),
      status: nextStatus,
      role: body.role ?? existing.role_code,
    });

    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
    ok(res, shape(row!));
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/users/:id/status — activate / deactivate / suspend. */
usersRouter.patch('/:id/status', requireAuth, requirePermission('users:manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = meta(statusSchema, req.body);
    const existing = await get<any>('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Worker not found.');
    if (existing.id === currentUser(req).id && body.status !== 'ACTIVE') {
      throw badRequest('You cannot disable your own account.');
    }

    await run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [body.status, await nowISO(), id]);
    if (body.status !== 'ACTIVE') await revokeAllSessions(id);

    await audit(req, 'WORKER_STATUS_CHANGED', 'user', id, { from: existing.status, to: body.status });
    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
    ok(res, shape(row!));
  } catch (err) {
    next(err);
  }
});

/** GET /api/users/:id/activity — a worker's own recent activity. */
usersRouter.get('/:id/activity', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    if (user.role !== 'ADMIN' && user.id !== id) throw forbidden();

    const limit = Math.min(100, Number(req.query.limit) || 30);
    const rows = await all(
      `SELECT t.id, t.type, t.summary, t.metadata, t.created_at, t.lead_id, l.lead_number,
              c.name AS customer_name, l.destination
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE t.actor_id = ? AND l.deleted_at IS NULL
       ORDER BY t.created_at DESC
       LIMIT ?`,
      [id, limit],
    );
    list(
      res,
      rows.map((r: any) => ({
        ...r,
        metadata: safeJson(r.metadata, {}),
      })),
      buildMeta(1, rows.length, rows.length),
    );
  } catch (err) {
    next(err);
  }
});

function safeJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
