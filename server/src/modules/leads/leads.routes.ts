import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray, toInt } from '../../lib/http.js';
import { todayStr, resolvePeriod } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { notify } from '../../services/notify.js';
import {
  ADMIN_ONLY_LEAD_FIELDS,
  assignLead,
  assertLeadWriteAccess,
  changeLeadStatus,
  effectiveFuStatus,
  loadLead,
  nextLeadNumber,
  shapeFollowUp,
  shapeLead,
} from './leads.service.js';
import { findDuplicates } from '../customers/customers.routes.js';
import { autoAssignLead } from '../../services/assigner.js';
import { assignmentConfig } from '../../services/settings.js';

export const leadsRouter = Router();

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .or(z.literal('').transform(() => null));

const isoStr = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date')
  .or(z.literal('').transform(() => null));

const leadCore = {
  destination: z.string().trim().min(2, 'Destination is required').max(200),
  travel_type: z.enum(['DOMESTIC', 'INTERNATIONAL']),
  trip_type: z.string().trim().max(60).optional().nullable(),
  requirements: z.array(z.string().trim().max(60)).max(30).default([]),
  travel_start_date: dateStr.optional().nullable(),
  travel_end_date: dateStr.optional().nullable(),
  duration_days: z.number().int().min(0).max(365).optional().nullable(),
  adults: z.number().int().min(1).max(99).default(2),
  children: z.number().int().min(0).max(99).default(0),
  budget: z.number().min(0).max(1_000_000_000).optional().nullable(),
  currency: z.string().trim().length(3).default('INR'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  notes: z.string().trim().max(4000).optional().nullable(),
  last_contacted_at: isoStr.optional().nullable(),
  next_follow_up_at: isoStr.optional().nullable(),
};

const createLeadSchema = z
  .object({
    customer_id: z.number().int().positive().optional(),
    customer: z
      .object({
        name: z.string().trim().min(2).max(150),
        phone: z.string().trim().max(30).optional().nullable(),
        whatsapp: z.string().trim().max(30).optional().nullable(),
        email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
        city: z.string().trim().max(100).optional().nullable(),
        state: z.string().trim().max(100).optional().nullable(),
        country: z.string().trim().max(100).optional().nullable(),
      })
      .optional(),
    source_id: z.number().int().positive().optional().nullable(),
    status: z.string().trim().min(1).default('NEW'),
    assigned_to: z.number().int().positive().optional().nullable(),
    allow_duplicate: z.boolean().optional(),
    ...leadCore,
  })
  .refine((v) => v.customer_id || v.customer, { message: 'Select an existing customer or provide customer details' })
  .refine(
    (v) => !v.travel_start_date || !v.travel_end_date || v.travel_end_date >= v.travel_start_date,
    { message: 'End date must be on or after start date', path: ['travel_end_date'] },
  );

const updateLeadSchema = z
  .object({
    customer_id: z.number().int().positive().optional(),
    source_id: z.number().int().positive().optional().nullable(),
    status: z.string().trim().min(1).optional(),
    assigned_to: z.number().int().positive().optional().nullable(),
    allow_duplicate: z.boolean().optional(),
    ...leadCore,
  })
  .partial();

const assignSchema = z.object({
  worker_id: z.number().int().positive().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
});

const bulkAssignSchema = z.object({
  lead_ids: z.array(z.number().int().positive()).min(1, 'Select at least one lead').max(500),
  worker_id: z.number().int().positive().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
});

const statusSchema = z.object({
  status: z.string().trim().min(1),
  remark: z.string().trim().max(500).optional().nullable(),
});

const noteSchema = z.object({
  content: z.string().trim().min(1, 'Note cannot be empty').max(4000),
});

const FOLLOW_UP_TERMINAL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;

const LEAD_SELECT = `
  SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp,
         c.email AS customer_email, c.city AS customer_city,
         s.code AS status_code, s.name AS status_name, s.category AS status_category, s.color AS status_color,
         src.name AS source_name, u.name AS assignee_name, u.status AS assignee_status,
         creator.name AS created_by_name,
         (SELECT MIN(f.scheduled_date) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}) AS next_fu_date,
         (SELECT f.status FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
            ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 1) AS next_fu_status,
         (SELECT COUNT(*) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
              AND f.scheduled_date < '${todayStr()}') AS overdue_follow_ups,
         (SELECT COUNT(*) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}) AS open_follow_ups
  FROM leads l
  JOIN customers c ON c.id = l.customer_id
  JOIN lead_statuses s ON s.id = l.status_id
  LEFT JOIN lead_sources src ON src.id = l.source_id
  LEFT JOIN users u ON u.id = l.assigned_to
  LEFT JOIN users creator ON creator.id = l.created_by`;

interface LeadFilters {
  search: string;
  statuses: string[];
  sources: number[];
  workers: number[];
  priorities: string[];
  travel_type?: string;
  trip_type?: string;
  destination: string;
  assigned?: string;
  period?: string;
  dateField: string;
  dateFrom?: string;
  dateTo?: string;
  followUpStatuses: string[];
  customerId?: number;
}

function buildWhere(filters: LeadFilters, req: any): { where: string[]; params: unknown[] } {
  const user = currentUser(req);
  const readAll = can(req, 'leads:read_all');
  const where: string[] = ['l.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (!readAll) {
    where.push('l.assigned_to = ?');
    params.push(user.id);
  }

  if (filters.search) {
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.whatsapp LIKE ? ESCAPE '\\'
        OR c.email LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\' OR l.destination LIKE ? ESCAPE '\\'
        OR u.name LIKE ? ESCAPE '\\')`,
    );
    const term = likeTerm(filters.search);
    params.push(term, term, term, term, term, term, term);
  }
  if (filters.statuses.length) {
    where.push(`s.code IN (${filters.statuses.map(() => '?').join(',')})`);
    params.push(...filters.statuses);
  }
  if (filters.sources.length) {
    where.push(`l.source_id IN (${filters.sources.map(() => '?').join(',')})`);
    params.push(...filters.sources);
  }
  if (filters.workers.length) {
    where.push(`l.assigned_to IN (${filters.workers.map(() => '?').join(',')})`);
    params.push(...filters.workers);
  }
  if (filters.priorities.length) {
    where.push(`l.priority IN (${filters.priorities.map(() => '?').join(',')})`);
    params.push(...filters.priorities);
  }
  if (filters.travel_type) {
    where.push('l.travel_type = ?');
    params.push(filters.travel_type);
  }
  if (filters.trip_type) {
    where.push('l.trip_type = ?');
    params.push(filters.trip_type);
  }
  if (filters.destination) {
    where.push(`l.destination LIKE ? ESCAPE '\\'`);
    params.push(likeTerm(filters.destination));
  }
  if (filters.assigned === 'unassigned') where.push('l.assigned_to IS NULL');
  if (filters.assigned === 'assigned') where.push('l.assigned_to IS NOT NULL');
  if (filters.customerId) {
    where.push('l.customer_id = ?');
    params.push(filters.customerId);
  }

  const range = resolvePeriod(filters.period, filters.dateFrom, filters.dateTo);
  const dateColumn =
    filters.dateField === 'last_contacted'
      ? 'l.last_contacted_at'
      : filters.dateField === 'next_follow_up'
        ? 'l.next_follow_up_at'
        : 'l.created_at';
  if (range.from) {
    where.push(`${dateColumn} >= ?`);
    params.push(range.from);
  }
  if (range.to) {
    where.push(`${dateColumn} < ?`);
    params.push(range.to);
  }

  if (filters.followUpStatuses.length) {
    for (const status of filters.followUpStatuses) {
      const effective = effectiveFuStatus('f.status', 'f.scheduled_date');
      where.push(
        `EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND ${effective.sql} = ?)`,
      );
      params.push(...effective.params, status);
    }
  }

  return { where, params };
}

function readFilters(req: any): LeadFilters {
  return {
    search: String(req.query.search ?? '').trim(),
    statuses: toArray(req.query.status),
    sources: toArray(req.query.source).map(Number).filter(Number.isFinite),
    workers: toArray(req.query.worker).map(Number).filter(Number.isFinite),
    priorities: toArray(req.query.priority),
    travel_type: String(req.query.travel_type ?? '').trim() || undefined,
    trip_type: String(req.query.trip_type ?? '').trim() || undefined,
    destination: String(req.query.destination ?? '').trim(),
    assigned: String(req.query.assigned ?? '').trim() || undefined,
    period: String(req.query.period ?? '').trim() || undefined,
    dateField: String(req.query.date_field ?? 'created').trim(),
    dateFrom: String(req.query.date_from ?? '').trim() || undefined,
    dateTo: String(req.query.date_to ?? '').trim() || undefined,
    followUpStatuses: toArray(req.query.follow_up_status),
    customerId: toInt(req.query.customer_id),
  };
}

/* ------------------------------- routes ------------------------------- */

leadsRouter.get('/check-duplicate', requireAuth, (req, res, next) => {
  try {
    const customers = findDuplicates({
      phone: String(req.query.phone ?? ''),
      whatsapp: String(req.query.whatsapp ?? ''),
      email: String(req.query.email ?? ''),
    });
    const leadMatches = customers.length
      ? all(
          `SELECT l.id, l.lead_number, l.destination, l.created_at, s.code AS status
           FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.deleted_at IS NULL AND l.customer_id IN (${customers.map(() => '?').join(',')})
           ORDER BY l.created_at DESC LIMIT 20`,
          customers.map((c) => c.id),
        )
      : [];
    ok(res, { customers, leads: leadMatches, is_duplicate: customers.length > 0 });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/', requireAuth, (req, res, next) => {
  try {
    if (!can(req, 'leads:read_all') && !can(req, 'leads:read_own')) throw forbidden();
    const { page, limit, offset } = pagination(req.query, 20, 200);
    const filters = readFilters(req);
    const { where, params } = buildWhere(filters, req);
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       LEFT JOIN users u ON u.id = l.assigned_to
       ${whereSql}`,
      params,
    )!.c;

    const sort = String(req.query.sort ?? 'recent');
    const orderSql =
      sort === 'oldest'
        ? 'l.created_at ASC, l.id ASC'
        : sort === 'updated'
          ? 'l.updated_at DESC'
          : sort === 'priority'
            ? `CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END ASC, l.created_at DESC`
            : sort === 'follow_up'
              ? 'next_fu_date IS NULL, next_fu_date ASC, l.created_at DESC'
              : 'l.created_at DESC, l.id DESC';

    const rows = all(`${LEAD_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);

    list(res, rows.map(shapeLead), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/', requireAuth, requirePermission('leads:create'), (req, res, next) => {
  try {
    const body = meta(createLeadSchema, req.body);
    const user = currentUser(req);

    let customerId = body.customer_id ?? null;
    let duplicateWarnings: unknown[] = [];

    if (!customerId && body.customer) {
      duplicateWarnings = findDuplicates(body.customer);
      if (duplicateWarnings.length && !body.allow_duplicate) {
        return res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: 'Possible duplicate customer found.',
            details: { duplicates: duplicateWarnings },
          },
        });
      }
      const now = nowISO();
      customerId = run(
        `INSERT INTO customers (name, phone, whatsapp, email, city, state, country, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.customer.name,
          body.customer.phone ?? null,
          body.customer.whatsapp ?? body.customer.phone ?? null,
          body.customer.email || null,
          body.customer.city ?? null,
          body.customer.state ?? null,
          body.customer.country ?? null,
          user.id,
          now,
          now,
        ],
      ).lastInsertRowid;
    }

    if (!customerId) throw badRequest('Customer is required.');
    const customer = get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [customerId]);
    if (!customer) throw badRequest('Selected customer does not exist.');

    if (body.assigned_to && !can(req, 'leads:assign')) {
      throw forbidden('You do not have permission to assign leads.');
    }

    const status = get<{ id: number }>('SELECT id FROM lead_statuses WHERE code = ? AND is_active = 1', [body.status]);
    if (!status) throw badRequest('Unknown lead status.');

    if (body.source_id) {
      const source = get('SELECT id FROM lead_sources WHERE id = ? AND is_active = 1', [body.source_id]);
      if (!source) throw badRequest('Unknown lead source.');
    }

    const now = nowISO();
    const leadId = tx(() => {
      const inserted = run(
        `INSERT INTO leads (lead_number, customer_id, source_id, assigned_to, destination, travel_type, trip_type,
          requirements, travel_start_date, travel_end_date, duration_days, adults, children, total_travelers,
          budget, currency, priority, status_id, last_contacted_at, next_follow_up_at, notes, created_by, updated_by,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextLeadNumber(),
          customerId,
          body.source_id ?? null,
          body.assigned_to ?? null,
          body.destination,
          body.travel_type,
          body.trip_type ?? null,
          JSON.stringify(body.requirements ?? []),
          body.travel_start_date ?? null,
          body.travel_end_date ?? null,
          body.duration_days ?? null,
          body.adults,
          body.children,
          body.adults + body.children,
          body.budget ?? null,
          body.currency,
          body.priority,
          status.id,
          body.last_contacted_at ?? null,
          body.next_follow_up_at ?? null,
          body.notes ?? null,
          user.id,
          user.id,
          now,
          now,
        ],
      ).lastInsertRowid;

      addTimelineEvent({
        leadId: inserted,
        type: TIMELINE_TYPES.LEAD_CREATED,
        actorId: user.id,
        summary: `Lead created by ${user.name}`,
        metadata: { destination: body.destination, source_id: body.source_id ?? null, customer_id: customerId },
      });

      return inserted;
    });

    if (body.assigned_to) {
      const lead = get<any>('SELECT * FROM leads WHERE id = ?', [leadId])!;
      assignLead({ lead, toUserId: body.assigned_to, actorId: user.id, actorName: user.name });
    } else if (assignmentConfig().auto_assign_new) {
      const lead = get<any>('SELECT * FROM leads WHERE id = ?', [leadId])!;
      autoAssignLead({ lead, actorId: user.id, actorName: user.name });
    }

    audit(req, 'LEAD_CREATED', 'lead', leadId, {
      destination: body.destination,
      customer_id: customerId,
      assigned_to: body.assigned_to ?? null,
      duplicates: duplicateWarnings.length,
    });

    const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    created(res, shapeLead(row!));
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id(\\d+)', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    loadLead(leadId, req);
    const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    if (!row) throw notFound('Lead not found.');
    const detail = shapeLead(row);

    const statusHistory = all(
      `SELECT h.id, h.remark, h.changed_at, fs.code AS from_code, fs.name AS from_name, ts.code AS to_code, ts.name AS to_name,
              u.name AS changed_by_name
       FROM lead_status_history h
       LEFT JOIN lead_statuses fs ON fs.id = h.from_status_id
       JOIN lead_statuses ts ON ts.id = h.to_status_id
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.lead_id = ? ORDER BY h.changed_at ASC`,
      [leadId],
    );

    const openFollowUps = all(
      `SELECT f.*, u.name AS worker_name FROM follow_ups f JOIN users u ON u.id = f.worker_id
       WHERE f.lead_id = ? AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
       ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 5`,
      [leadId],
    );

    ok(res, {
      ...detail,
      status_history: statusHistory,
      open_follow_ups_list: openFollowUps.map(shapeFollowUp),
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch('/:id(\\d+)', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = loadLead(leadId, req);
    assertLeadWriteAccess(lead, req);
    const body = meta(updateLeadSchema, req.body);
    const user = currentUser(req);

    const isAdminFieldChange = ADMIN_ONLY_LEAD_FIELDS.some(
      (field) => (body as any)[field] !== undefined && (body as any)[field] !== (lead as any)[field],
    );
    if (isAdminFieldChange && !can(req, 'leads:update')) {
      throw forbidden('Only an administrator can change customer, source or assignment.');
    }

    if (
      body.travel_start_date &&
      body.travel_end_date &&
      body.travel_end_date < body.travel_start_date
    ) {
      throw badRequest('End date must be on or after start date.');
    }

    const now = nowISO();
    const changed: string[] = [];

    tx(() => {
      run(
        `UPDATE leads SET destination = ?, travel_type = ?, trip_type = ?, requirements = ?,
          travel_start_date = ?, travel_end_date = ?, duration_days = ?, adults = ?, children = ?, total_travelers = ?,
          budget = ?, currency = ?, priority = ?, notes = ?, last_contacted_at = ?, next_follow_up_at = ?,
          source_id = COALESCE(?, source_id), customer_id = COALESCE(?, customer_id),
          updated_at = ?, updated_by = ? WHERE id = ?`,
        [
          body.destination ?? lead.destination,
          body.travel_type ?? lead.travel_type,
          body.trip_type !== undefined ? body.trip_type : lead.trip_type,
          body.requirements ? JSON.stringify(body.requirements) : lead.requirements,
          body.travel_start_date !== undefined ? body.travel_start_date : lead.travel_start_date,
          body.travel_end_date !== undefined ? body.travel_end_date : lead.travel_end_date,
          body.duration_days !== undefined ? body.duration_days : lead.duration_days,
          body.adults ?? lead.adults,
          body.children ?? lead.children,
          (body.adults ?? lead.adults) + (body.children ?? lead.children),
          body.budget !== undefined ? body.budget : lead.budget,
          body.currency ?? lead.currency,
          body.priority ?? lead.priority,
          body.notes !== undefined ? body.notes : lead.notes,
          body.last_contacted_at !== undefined ? body.last_contacted_at : lead.last_contacted_at,
          body.next_follow_up_at !== undefined ? body.next_follow_up_at : lead.next_follow_up_at,
          body.source_id !== undefined ? body.source_id : null,
          body.customer_id !== undefined ? body.customer_id : null,
          now,
          user.id,
          leadId,
        ],
      );

      for (const key of Object.keys(body)) {
        if (key === 'allow_duplicate') continue;
        const before = (lead as any)[key];
        const after = (body as any)[key];
        if (after !== undefined && JSON.stringify(after) !== JSON.stringify(before)) changed.push(key);
      }

      if (changed.length) {
        addTimelineEvent({
          leadId,
          type: TIMELINE_TYPES.LEAD_UPDATED,
          actorId: user.id,
          summary: `Lead updated (${changed.join(', ')})`,
          metadata: { fields: changed },
        });
      }
    });

    if (body.status) {
      changeLeadStatus({ leadId, toCode: body.status, actorId: user.id });
    }

    if (changed.length || body.status) audit(req, 'LEAD_UPDATED', 'lead', leadId, { fields: changed, status: body.status });

    const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, shapeLead(row!));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/:id(\\d+)/status', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = loadLead(leadId, req);
    assertLeadWriteAccess(lead, req);
    const body = meta(statusSchema, req.body);
    const user = currentUser(req);

    const result = changeLeadStatus({ leadId, toCode: body.status, actorId: user.id, remark: body.remark });
    if (result) {
      audit(req, 'LEAD_STATUS_CHANGED', 'lead', leadId, result);
      if (result.to === 'CONVERTED') {
        notifyRoleAdmins(leadId, lead.lead_number, user.name, 'converted');
      }
    }

    const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, { ...shapeLead(row!), changed: Boolean(result) });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/:id(\\d+)/assign', requireAuth, requirePermission('leads:assign'), (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = loadLead(leadId, req);
    const body = meta(assignSchema, req.body);
    const user = currentUser(req);

    const result = assignLead({
      lead,
      toUserId: body.worker_id,
      actorId: user.id,
      actorName: user.name,
      reason: body.reason,
    });
    if (result.changed) {
      audit(req, result.to ? (result.from ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED') : 'LEAD_UNASSIGNED', 'lead', leadId, {
        from: result.from,
        to: result.to,
        reason: body.reason ?? null,
      });
    }

    const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, { ...shapeLead(row!), changed: result.changed });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/bulk/assign', requireAuth, requirePermission('leads:assign'), (req, res, next) => {
  try {
    const body = meta(bulkAssignSchema, req.body);
    const user = currentUser(req);
    const results = { assigned: 0, reassigned: 0, unchanged: 0, failed: [] as Array<{ id: number; message: string }> };

    for (const leadId of body.lead_ids) {
      try {
        const lead = get<any>('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
        if (!lead) {
          results.failed.push({ id: leadId, message: 'Lead not found' });
          continue;
        }
        const result = assignLead({
          lead,
          toUserId: body.worker_id,
          actorId: user.id,
          actorName: user.name,
          reason: body.reason,
        });
        if (!result.changed) results.unchanged += 1;
        else if (result.from) results.reassigned += 1;
        else results.assigned += 1;
        if (result.changed) {
          audit(req, result.from ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED', 'lead', leadId, {
            from: result.from,
            to: result.to,
            bulk: true,
          });
        }
      } catch (err) {
        results.failed.push({ id: leadId, message: (err as Error).message });
      }
    }

    ok(res, results);
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id(\\d+)/timeline', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    loadLead(leadId, req);
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const rows = all(
      `SELECT t.id, t.type, t.summary, t.metadata, t.created_at, u.name AS actor_name, u.id AS actor_id
       FROM lead_timeline t LEFT JOIN users u ON u.id = t.actor_id
       WHERE t.lead_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      [leadId, limit],
    );
    ok(
      res,
      rows.map((r: any) => ({ ...r, metadata: parseJson(r.metadata, {}) })),
    );
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id(\\d+)/assignments', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    loadLead(leadId, req);
    const rows = all(
      `SELECT a.id, a.action, a.reason, a.assigned_at, a.released_at, a.is_active,
              to_u.name AS assigned_to_name, to_u.id AS assigned_to_id,
              by_u.name AS assigned_by_name
       FROM lead_assignments a
       JOIN users to_u ON to_u.id = a.assigned_to
       JOIN users by_u ON by_u.id = a.assigned_by
       WHERE a.lead_id = ? ORDER BY a.assigned_at DESC`,
      [leadId],
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id(\\d+)/notes', requireAuth, (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    loadLead(leadId, req);
    const rows = all(
      `SELECT n.id, n.content, n.created_at, n.updated_at, u.id AS author_id, u.name AS author_name
       FROM notes n JOIN users u ON u.id = n.author_id
       WHERE n.lead_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at DESC`,
      [leadId],
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/:id(\\d+)/notes', requireAuth, requirePermission('notes:create'), (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = loadLead(leadId, req);
    if (!can(req, 'leads:update') && lead.assigned_to !== currentUser(req).id) {
      throw forbidden('You can only add notes to your own leads.');
    }
    const body = meta(noteSchema, req.body);
    const user = currentUser(req);
    const now = nowISO();
    const noteId = run('INSERT INTO notes (lead_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      leadId,
      user.id,
      body.content,
      now,
      now,
    ]).lastInsertRowid;

    addTimelineEvent({
      leadId,
      type: TIMELINE_TYPES.NOTE_ADDED,
      actorId: user.id,
      summary: `Note added by ${user.name}`,
      metadata: { note_id: noteId, preview: body.content.slice(0, 120) },
    });
    audit(req, 'NOTE_ADDED', 'lead', leadId, { note_id: noteId });

    created(res, {
      id: noteId,
      content: body.content,
      created_at: now,
      updated_at: now,
      author_id: user.id,
      author_name: user.name,
    });
  } catch (err) {
    next(err);
  }
});

function notifyRoleAdmins(leadId: number, leadNumber: string, actorName: string, outcome: string): void {
  const admins = all<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'ADMIN' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
  );
  for (const admin of admins) {
    notify({
      userId: admin.id,
      type: 'LEAD_CONVERTED',
      title: `${leadNumber} marked as converted`,
      body: `${actorName} marked this lead as converted.`,
      entity: 'lead',
      entityId: leadId,
      link: `/leads/${leadId}`,
    });
  }
  void outcome;
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
