import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { notify } from '../../services/notify.js';
import { changeLeadStatus, effectiveFuStatus, shapeFollowUp } from '../leads/leads.service.js';
import { FU_SELECT, createFollowUpRecord, shapedFollowUpById } from './followups.service.js';

export const followUpsRouter = Router();

export const BOARD_COLUMNS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'TODAY', label: 'Today' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CONVERTED', label: 'Converted' },
  { key: 'NOT_INTERESTED', label: 'Not Interested' },
] as const;


const createSchema = z.object({
  lead_id: z.number().int().positive(),
  worker_id: z.number().int().positive().optional(),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  scheduled_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format')
    .optional()
    .nullable(),
  type: z.string().trim().max(40).default('Call'),
  notes: z.string().trim().max(2000).optional().nullable(),
  next_action: z.string().trim().max(500).optional().nullable(),
});

const updateSchema = z.object({
  status: z.string().trim().min(1).optional(),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
  scheduled_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format')
    .optional()
    .nullable(),
  type: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  customer_response: z.string().trim().max(2000).optional().nullable(),
  next_action: z.string().trim().max(500).optional().nullable(),
  worker_id: z.number().int().positive().optional(),
});

const TERMINAL = ['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED'];
const OUTCOMES = ['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'CALLBACK_REQUESTED', 'CANCELLED'];

interface FollowUpRow {
  id: number;
  lead_id: number;
  worker_id: number;
  status: string;
  scheduled_date: string;
  scheduled_time: string | null;
  deleted_at?: string | null;
  [key: string]: any;
}

async function loadFollowUp(id: number, req: any): Promise<FollowUpRow> {
  const row = await get<FollowUpRow>('SELECT * FROM follow_ups WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) throw notFound('Follow-up not found.');
  const user = currentUser(req);
  const readAll = can(req, 'follow_ups:read_all');
  if (!readAll && row.worker_id !== user.id) throw forbidden('You do not have access to this follow-up.');
  return row;
}

function assertFollowUpWrite(row: FollowUpRow, req: any): void {
  const user = currentUser(req);
  if (can(req, 'follow_ups:update')) return;
  if (can(req, 'follow_ups:update_own') && row.worker_id === user.id) return;
  throw forbidden('You do not have permission to update this follow-up.');
}

async function buildFilters(req: any): Promise<{ where: string[]; params: unknown[] }> {
  const user = currentUser(req);
  const where: string[] = ['f.deleted_at IS NULL', 'l.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (!can(req, 'follow_ups:read_all')) {
    where.push('f.worker_id = ?');
    params.push(user.id);
  }

  const search = String(req.query.search ?? '').trim();
  if (search) {
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\'
        OR l.destination LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')`,
    );
    const term = await likeTerm(search);
    params.push(term, term, term, term, term);
  }

  const workerIds = toArray(req.query.worker_id).map(Number).filter(Number.isFinite);
  if (workerIds.length) {
    where.push(`f.worker_id IN (${workerIds.map(() => '?').join(',')})`);
    params.push(...workerIds);
  }

  const leadId = Number(req.query.lead_id);
  if (leadId) {
    where.push('f.lead_id = ?');
    params.push(leadId);
  }

  const statuses = toArray(req.query.status);
  if (statuses.length) {
    const effective = effectiveFuStatus('f.status', 'f.scheduled_date');
    const inStored = statuses.filter((s) => !['TODAY', 'OVERDUE'].includes(s));
    const inEffective = statuses.filter((s) => ['TODAY', 'OVERDUE'].includes(s));
    const clauses: string[] = [];
    if (inStored.length) {
      clauses.push(`f.status IN (${inStored.map(() => '?').join(',')})`);
      params.push(...inStored);
    }
    if (inEffective.length) {
      clauses.push(`(${effective.sql}) IN (${inEffective.map(() => '?').join(',')})`);
      params.push(...effective.params, ...inEffective);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  const types = toArray(req.query.type);
  if (types.length) {
    where.push(`f.type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }

  const period = String(req.query.period ?? '').trim() || undefined;
  const from = String(req.query.date_from ?? '').trim();
  const to = String(req.query.date_to ?? '').trim();
  const dates = resolvePeriodDates(period, from || undefined, to || undefined);
  if (dates.from) {
    where.push('f.scheduled_date >= ?');
    params.push(dates.from);
  }
  if (dates.to) {
    where.push('f.scheduled_date <= ?');
    params.push(dates.to);
  }

  return { where, params };
}

/** GET /api/follow-ups — paginated follow-up list (server-side filtering). */
followUpsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!can(req, 'follow_ups:read_all') && !can(req, 'follow_ups:read_own')) throw forbidden();
    const { page, limit, offset } = pagination(req.query, 25, 200);
    const { where, params } = await buildFilters(req);
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       ${whereSql}`,
      params,
    ))!.c;

    const sort = String(req.query.sort ?? 'date');
    const order =
      sort === 'recent'
        ? 'f.created_at DESC'
        : sort === 'status'
          ? 'f.status ASC, f.scheduled_date ASC'
          : 'f.scheduled_date ASC, f.scheduled_time ASC, f.id ASC';

    const rows = await all(`${FU_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeFollowUp), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/** GET /api/follow-ups/board — Kanban columns for the follow-up board. */
followUpsRouter.get('/board', requireAuth, async (req, res, next) => {
  try {
    if (!can(req, 'follow_ups:read_all') && !can(req, 'follow_ups:read_own')) throw forbidden();
    const { where, params } = await buildFilters(req);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const cap = Math.min(1000, Number(req.query.limit) || 300);

    const rows = await all(`${FU_SELECT} ${whereSql} ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT ?`, [
      ...params,
      cap,
    ]);
    const shaped = rows.map(shapeFollowUp);

    const counts = await all(
      `SELECT ${effectiveFuStatus('f.status', 'f.scheduled_date').sql.replace(/\?/g, `'${todayStr()}'`)} AS eff,
              COUNT(*) AS cnt
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       ${whereSql}
       GROUP BY eff`,
      params,
    );

    const columns = BOARD_COLUMNS.map((col) => {
      const items = shaped.filter((f) => f.board_column === col.key);
      const countRow = counts.find((c: any) => {
        const eff = c.eff;
        if (col.key === 'PENDING') return !['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED', 'OVERDUE', 'TODAY'].includes(eff);
        if (col.key === 'NOT_INTERESTED') return eff === 'NOT_INTERESTED' || eff === 'CANCELLED';
        return eff === col.key;
      });
      return { key: col.key, label: col.label, count: Number(countRow?.cnt ?? items.length), items };
    });

    ok(res, { columns, truncated: rows.length >= cap });
  } catch (err) {
    next(err);
  }
});

/** POST /api/follow-ups — schedule a follow-up for a lead. */
followUpsRouter.post('/', requireAuth, requirePermission('follow_ups:create'), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    const user = currentUser(req);

    const id = await createFollowUpRecord({
      input: body,
      user,
      canCrossAssign: can(req, 'follow_ups:update'),
      canScheduleOnAnyLead: can(req, 'leads:read_all'),
      req,
    });

    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    created(res, shapeFollowUp(row!));
  } catch (err) {
    next(err);
  }
});

/** GET /api/follow-ups/:id */
followUpsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadFollowUp(id, req);
    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    if (!row) throw notFound('Follow-up not found.');
    ok(res, shapeFollowUp(row));
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/follow-ups/:id — update details, reschedule or record an outcome. */
followUpsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadFollowUp(id, req);
    assertFollowUpWrite(existing, req);
    const body = meta(updateSchema, req.body);
    const user = currentUser(req);
    const now = await nowISO();

    if (body.worker_id && body.worker_id !== existing.worker_id) {
      if (!can(req, 'follow_ups:update')) throw forbidden('You cannot reassign this follow-up.');
      const worker = await get<{ id: number; status: string }>('SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL', [
        body.worker_id,
      ]);
      if (!worker || worker.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');
    }

    const nextStatus = body.status ?? existing.status;
    if (body.status && !OUTCOMES.includes(body.status) && body.status !== 'PENDING' && body.status !== 'RESCHEDULED') {
      throw badRequest('Unknown follow-up status.');
    }

    const dateChanged = body.scheduled_date && body.scheduled_date !== existing.scheduled_date;
    let resolvedStatus = nextStatus;
    if (!body.status && dateChanged && !TERMINAL.includes(existing.status)) {
      resolvedStatus = 'RESCHEDULED';
    }
    const becameTerminal = TERMINAL.includes(resolvedStatus) && !TERMINAL.includes(existing.status);
    const reopened = !TERMINAL.includes(resolvedStatus) && TERMINAL.includes(existing.status);

    await run(
      `UPDATE follow_ups SET scheduled_date = ?, scheduled_time = ?, type = ?, status = ?, notes = ?,
        customer_response = ?, next_action = ?, worker_id = ?,
        completed_at = ?,
        completed_by = ?,
        updated_at = ? WHERE id = ?`,
      [
        body.scheduled_date ?? existing.scheduled_date,
        body.scheduled_time !== undefined ? body.scheduled_time : existing.scheduled_time,
        body.type ?? existing.type,
        resolvedStatus,
        body.notes !== undefined ? body.notes : existing.notes,
        body.customer_response !== undefined ? body.customer_response : existing.customer_response,
        body.next_action !== undefined ? body.next_action : existing.next_action,
        body.worker_id ?? existing.worker_id,
        becameTerminal ? now : null,
        becameTerminal ? user.id : null,
        now,
        id,
      ],
    );

    const lead = await get<{ id: number; lead_number: string; assigned_to: number | null }>(
      'SELECT id, lead_number, assigned_to FROM leads WHERE id = ?',
      [existing.lead_id],
    );

    if (becameTerminal) {
      await addTimelineEvent({
        leadId: existing.lead_id,
        type: TIMELINE_TYPES.FOLLOW_UP_COMPLETED,
        actorId: user.id,
        summary: `Follow-up marked as ${resolvedStatus} by ${user.name}`,
        metadata: {
          follow_up_id: id,
          status: resolvedStatus,
          customer_response: body.customer_response ?? null,
          next_action: body.next_action ?? null,
        },
      });

      // Business outcomes flow back to the lead pipeline.
      if (resolvedStatus === 'CONVERTED') {
        await changeLeadStatus({ leadId: existing.lead_id, toCode: 'CONVERTED', actorId: user.id, remark: 'Follow-up converted' });
      } else if (resolvedStatus === 'NOT_INTERESTED') {
        await changeLeadStatus({ leadId: existing.lead_id, toCode: 'NOT_INTERESTED', actorId: user.id, remark: 'Follow-up: not interested' });
      }
    } else {
      await addTimelineEvent({
        leadId: existing.lead_id,
        type: TIMELINE_TYPES.FOLLOW_UP_UPDATED,
        actorId: user.id,
        summary: dateChanged ? `Follow-up rescheduled to ${body.scheduled_date}` : `Follow-up updated (${resolvedStatus})`,
        metadata: { follow_up_id: id, status: resolvedStatus, from_date: existing.scheduled_date },
      });
    }

    await audit(req, becameTerminal ? 'FOLLOW_UP_COMPLETED' : 'FOLLOW_UP_UPDATED', 'follow_up', id, {
      status: resolvedStatus,
      previous_status: existing.status,
      lead_id: existing.lead_id,
      reopened,
    });

    if (becameTerminal && lead && lead.assigned_to && lead.assigned_to !== user.id) {
      await notify({
        userId: lead.assigned_to,
        type: 'FOLLOW_UP_COMPLETED',
        title: `Follow-up ${resolvedStatus.toLowerCase()}: ${lead.lead_number}`,
        body: `${user.name} marked a follow-up as ${resolvedStatus.replace('_', ' ').toLowerCase()}.`,
        entity: 'lead',
        entityId: lead.id,
        link: `/leads/${lead.id}`,
      });
    }

    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    ok(res, shapeFollowUp(row!));
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/follow-ups/:id — soft-cancel (history preserved). */
followUpsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadFollowUp(id, req);
    assertFollowUpWrite(existing, req);
    const user = currentUser(req);

    await run('UPDATE follow_ups SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', [
      'CANCELLED',
      await nowISO(),
      await nowISO(),
      id,
    ]);
    await addTimelineEvent({
      leadId: existing.lead_id,
      type: TIMELINE_TYPES.FOLLOW_UP_UPDATED,
      actorId: user.id,
      summary: 'Follow-up cancelled',
      metadata: { follow_up_id: id },
    });
    await audit(req, 'FOLLOW_UP_CANCELLED', 'follow_up', id, { lead_id: existing.lead_id });
    ok(res, { cancelled: true });
  } catch (err) {
    next(err);
  }
});
