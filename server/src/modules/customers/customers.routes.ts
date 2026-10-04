import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run } from '../../db/database.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';

export const customersRouter = Router();

const customerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(150),
  phone: z.string().trim().max(30).optional().nullable(),
  whatsapp: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email('Valid email required').max(200).optional().nullable().or(z.literal('').transform(() => null)),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  allow_duplicate: z.boolean().optional(),
});

const updateSchema = customerSchema.partial();

function shape(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    city: row.city,
    state: row.state,
    country: row.country,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lead_count: Number(row.lead_count ?? 0),
    last_lead_at: row.last_lead_at ?? null,
  };
}

function duplicateWhere(field: 'phone' | 'whatsapp' | 'email', value: string) {
  if (!value) return null;
  if (field === 'email') return { sql: 'lower(c.email) = lower(?)', value };
  if (field === 'phone' || field === 'whatsapp') {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 6) return null;
    const tail = digits.slice(-8);
    return { sql: `(replace(replace(replace(replace(coalesce(c.${field},''), '-',''), ' ',''), '+',''), '.', '') LIKE ?)`, value: `%${tail}` };
  }
  return null;
}

export function findDuplicates(
  input: { phone?: string | null; whatsapp?: string | null; email?: string | null },
  excludeId?: number,
): Array<Record<string, any>> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const field of ['phone', 'whatsapp', 'email'] as const) {
    const match = duplicateWhere(field, input[field] ?? '');
    if (match) {
      clauses.push(match.sql);
      params.push(match.value);
    }
  }
  if (!clauses.length) return [];
  let sql = `SELECT c.id, c.name, c.phone, c.whatsapp, c.email, c.city, c.created_at,
      (SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS lead_count
     FROM customers c
     WHERE c.deleted_at IS NULL AND (${clauses.join(' OR ')})`;
  if (excludeId) {
    sql += ' AND c.id <> ?';
    params.push(excludeId);
  }
  return all(sql, params);
}

/** GET /api/customers/check-duplicate — warn before creating/updating. */
customersRouter.get('/check-duplicate', requireAuth, (req, res, next) => {
  try {
    const excludeId = req.query.exclude_id ? Number(req.query.exclude_id) : undefined;
    const matches = findDuplicates(
      {
        phone: String(req.query.phone ?? ''),
        whatsapp: String(req.query.whatsapp ?? ''),
        email: String(req.query.email ?? ''),
      },
      excludeId,
    );
    ok(res, { duplicates: matches, is_duplicate: matches.length > 0 });
  } catch (err) {
    next(err);
  }
});

/** GET /api/customers — searchable, paginated customer list. */
customersRouter.get('/', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const { page, limit, offset } = pagination(req.query);
    const search = String(req.query.search ?? '').trim();
    const sort = String(req.query.sort ?? 'recent');

    const readAll = can(req, 'customers:read_all');
    if (!readAll && !can(req, 'customers:read_own')) throw forbidden();

    const where: string[] = ['c.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!readAll) {
      where.push('c.id IN (SELECT l.customer_id FROM leads l WHERE l.assigned_to = ? AND l.deleted_at IS NULL)');
      params.push(user.id);
    }
    if (search) {
      where.push(
        `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.whatsapp LIKE ? ESCAPE '\\'
          OR c.email LIKE ? ESCAPE '\\' OR c.city LIKE ? ESCAPE '\\')`,
      );
      const term = likeTerm(search);
      params.push(term, term, term, term, term);
    }

    const selected = toArray(req.query.selected);
    if (selected.length) {
      where.push(`c.id IN (${selected.map(() => '?').join(',')})`);
      params.push(...selected.map(Number));
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM customers c ${whereSql}`, params)!.c;

    const order =
      sort === 'name' ? 'c.name COLLATE NOCASE ASC' : sort === 'oldest' ? 'c.created_at ASC' : 'c.created_at DESC';

    const rows = all(
      `SELECT c.*,
              (SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS lead_count,
              (SELECT MAX(l.created_at) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS last_lead_at
       FROM customers c ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    list(res, rows.map(shape), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/** POST /api/customers — create a customer (duplicate-aware). */
customersRouter.post('/', requireAuth, requirePermission('customers:manage'), (req, res, next) => {
  try {
    const body = meta(customerSchema, req.body);
    const duplicates = findDuplicates(body);
    if (duplicates.length && !body.allow_duplicate) {
      throw conflict('Possible duplicate customer found.', { duplicates });
    }

    const now = nowISO();
    const id = run(
      `INSERT INTO customers (name, phone, whatsapp, email, city, state, country, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name,
        body.phone ?? null,
        body.whatsapp ?? body.phone ?? null,
        body.email ?? null,
        body.city ?? null,
        body.state ?? null,
        body.country ?? null,
        body.notes ?? null,
        currentUser(req).id,
        now,
        now,
      ],
    ).lastInsertRowid;

    audit(req, 'CUSTOMER_CREATED', 'customer', id, { name: body.name, duplicates: duplicates.length });
    const row = get('SELECT * FROM customers WHERE id = ?', [id]);
    created(res, shape({ ...row!, lead_count: 0 }));
  } catch (err) {
    next(err);
  }
});

/** GET /api/customers/:id — customer profile with its leads. */
customersRouter.get('/:id', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    const row = get<any>('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Customer not found.');

    const readAll = can(req, 'customers:read_all');
    const leads = all(
      `SELECT l.id, l.lead_number, l.destination, l.travel_type, l.trip_type, l.priority, l.budget, l.currency,
              l.created_at, l.next_follow_up_at, s.code AS status_code, s.name AS status_name, s.category AS status_category,
              s.color AS status_color, u.name AS assignee_name, l.assigned_to
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.customer_id = ? AND l.deleted_at IS NULL
         ${readAll ? '' : 'AND l.assigned_to = ?'}
       ORDER BY l.created_at DESC`,
      readAll ? [id] : [id, user.id],
    );

    if (!readAll && leads.length === 0) {
      const owned = get('SELECT 1 FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL', [
        id,
        user.id,
      ]);
      if (!owned) throw forbidden('You do not have access to this customer.');
    }

    ok(res, {
      ...shape({ ...row, lead_count: leads.length }),
      leads: leads.map((l: any) => ({
        id: l.id,
        lead_number: l.lead_number,
        destination: l.destination,
        travel_type: l.travel_type,
        trip_type: l.trip_type,
        priority: l.priority,
        budget: l.budget,
        currency: l.currency,
        created_at: l.created_at,
        next_follow_up_at: l.next_follow_up_at,
        status: {
          code: l.status_code,
          name: l.status_name,
          category: l.status_category,
          color: l.status_color,
        },
        assignee: l.assigned_to ? { id: l.assigned_to, name: l.assignee_name } : null,
      })),
      duplicates: findDuplicates(row, id),
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/customers/:id */
customersRouter.patch('/:id', requireAuth, requirePermission('customers:manage'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get<any>('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Customer not found.');

    const body = meta(updateSchema, req.body);
    const merged = {
      phone: body.phone !== undefined ? body.phone : existing.phone,
      whatsapp: body.whatsapp !== undefined ? body.whatsapp : existing.whatsapp,
      email: body.email !== undefined ? body.email : existing.email,
    };
    const duplicates = findDuplicates(merged, id);
    if (duplicates.length && !body.allow_duplicate) {
      throw conflict('Possible duplicate customer found.', { duplicates });
    }

    run(
      `UPDATE customers SET name = ?, phone = ?, whatsapp = ?, email = ?, city = ?, state = ?, country = ?, notes = ?,
        updated_at = ? WHERE id = ?`,
      [
        body.name ?? existing.name,
        merged.phone,
        merged.whatsapp,
        merged.email,
        body.city !== undefined ? body.city : existing.city,
        body.state !== undefined ? body.state : existing.state,
        body.country !== undefined ? body.country : existing.country,
        body.notes !== undefined ? body.notes : existing.notes,
        nowISO(),
        id,
      ],
    );

    audit(req, 'CUSTOMER_UPDATED', 'customer', id, { changed: Object.keys(body) });
    const row = get('SELECT * FROM customers WHERE id = ?', [id]);
    ok(res, shape({ ...row!, lead_count: Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND deleted_at IS NULL', [id])?.c ?? 0) }));
  } catch (err) {
    next(err);
  }
});

/** POST /api/customers/:id/archive — soft-archive (history preserved). */
customersRouter.post('/:id/archive', requireAuth, requirePermission('customers:manage'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get<any>('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Customer not found.');
    const activeLeads = get<{ c: number }>('SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND deleted_at IS NULL', [
      id,
    ]);
    if (activeLeads && activeLeads.c > 0) throw conflict('Customer has active leads and cannot be archived.');

    run('UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowISO(), nowISO(), id]);
    audit(req, 'CUSTOMER_ARCHIVED', 'customer', id, { name: existing.name });
    ok(res, { archived: true });
  } catch (err) {
    next(err);
  }
});
