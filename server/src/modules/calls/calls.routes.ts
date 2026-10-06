import { Router, raw } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates, todayStr } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { callPolicy, retentionConfig } from '../../services/settings.js';
import { getTelephonyProvider } from '../../services/telephony.js';
import { changeLeadStatus, loadLead } from '../leads/leads.service.js';
import { createFollowUpRecord } from '../followups/followups.service.js';

export const callsRouter = Router();

export const CALL_STATUSES = ['RINGING', 'ANSWERED', 'MISSED', 'BUSY', 'FAILED', 'NO_ANSWER', 'COMPLETED'] as const;


const CALL_SELECT = `
  SELECT cl.*, l.lead_number, l.assigned_to AS lead_assignee, l.destination AS lead_destination,
         c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name,
         fu.scheduled_date AS follow_up_date, fu.status AS follow_up_status, fu.scheduled_time AS follow_up_time
  FROM calls cl
  LEFT JOIN leads l ON l.id = cl.lead_id
  LEFT JOIN customers c ON c.id = cl.customer_id
  LEFT JOIN users w ON w.id = cl.worker_id
  LEFT JOIN follow_ups fu ON fu.id = cl.follow_up_id`;

export function shapeCall(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    lead_destination: row.lead_destination ?? null,
    lead_assignee: row.lead_assignee ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    provider: row.provider,
    provider_call_id: row.provider_call_id ?? null,
    direction: row.direction,
    phone_number: row.phone_number ?? null,
    started_at: row.started_at ?? null,
    answered_at: row.answered_at ?? null,
    ended_at: row.ended_at ?? null,
    duration_seconds: row.duration_seconds ?? null,
    status: row.status,
    disposition: row.disposition ?? null,
    recording_available: Number(row.recording_available ?? 0) === 1,
    consent: row.consent ?? null,
    notes: row.notes ?? null,
    follow_up_id: row.follow_up_id ?? null,
    follow_up_date: row.follow_up_date ?? null,
    follow_up_time: row.follow_up_time ?? null,
    follow_up_status: row.follow_up_status ?? null,
    has_follow_up: Boolean(row.follow_up_id),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface CallRow {
  id: number;
  lead_id: number | null;
  customer_id: number | null;
  worker_id: number;
  status: string;
  [key: string]: any;
}

/** Permission-free row load — used by webhooks and by loadCall. */
export async function getCallRow(id: number): Promise<CallRow | undefined> {
  return await get<CallRow>('SELECT * FROM calls WHERE id = ? AND deleted_at IS NULL', [id]);
}

async function loadCall(id: number, req: any): Promise<CallRow> {
  const row = await getCallRow(id);
  if (!row) throw notFound('Call not found.');
  const user = req.user;
  if (!user) throw forbidden();
  if (!user.permissions.includes('calls:read_all') && row.worker_id !== user.id) {
    throw forbidden('You do not have access to this call.');
  }
  return row;
}

function assertCallWriteAccess(call: CallRow, req: any): void {
  const user = req.user!;
  const allowed =
    user.permissions.includes('calls:update') ||
    (user.permissions.includes('calls:update_own') && call.worker_id === user.id);
  if (!allowed) throw forbidden('You cannot modify this call.');
}

/** Resolves/validates the lead + customer a call belongs to. */
async function resolveTargets(req: any, body: { lead_id?: number | null; customer_id?: number | null }): Promise<{
  leadId: number | null;
  customerId: number | null;
}> {
  let leadId = body.lead_id ?? null;
  let customerId = body.customer_id ?? null;

  if (leadId) {
    const lead = await loadLead(leadId, req);
    if (!customerId) customerId = lead.customer_id;
  } else if (customerId) {
    const customer = await get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [customerId]);
    if (!customer) throw notFound('Customer not found.');
    if (!can(req, 'leads:read_all')) {
      const owned = await get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL',
        [customerId, currentUser(req).id],
      );
      if (!owned?.c) throw forbidden('You do not have access to this customer.');
    }
  }
  return { leadId, customerId };
}

async function phoneForTargets(leadId: number | null, customerId: number | null, explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  if (leadId) {
    const row = await get<{ phone: string | null }>(
      'SELECT c.phone FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?',
      [leadId],
    );
    if (row?.phone) return row.phone;
  }
  if (customerId) {
    const row = await get<{ phone: string | null }>('SELECT phone FROM customers WHERE id = ?', [customerId]);
    if (row?.phone) return row.phone;
  }
  return null;
}

/* ------------------------------- LIST ------------------------------- */

callsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where: string[] = ['cl.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!can(req, 'calls:read_all')) {
      where.push('cl.worker_id = ?');
      params.push(user.id);
    }

    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push('cl.lead_id = ?');
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push('cl.customer_id = ?');
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, 'calls:read_all')) {
      where.push('cl.worker_id = ?');
      params.push(workerId);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`cl.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const directions = toArray(req.query.direction);
    if (directions.length) {
      where.push(`cl.direction IN (${directions.map(() => '?').join(',')})`);
      params.push(...directions);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(
        `(cl.phone_number LIKE ? ESCAPE '\\' OR cl.notes LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\'
          OR c.name LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')`,
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );
    if (dates.from) {
      where.push('substr(COALESCE(cl.started_at, cl.created_at), 1, 10) >= ?');
      params.push(dates.from);
    }
    if (dates.to) {
      where.push('substr(COALESCE(cl.started_at, cl.created_at), 1, 10) <= ?');
      params.push(dates.to);
    }

    const sortMap: Record<string, string> = {
      recent: 'COALESCE(cl.started_at, cl.created_at) DESC',
      oldest: 'COALESCE(cl.started_at, cl.created_at) ASC',
      duration: 'COALESCE(cl.duration_seconds, 0) DESC',
    };
    const orderSql = sortMap[String(req.query.sort ?? 'recent')] ?? sortMap.recent;

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(`SELECT COUNT(*) AS c FROM calls cl
      LEFT JOIN leads l ON l.id = cl.lead_id
      LEFT JOIN customers c ON c.id = cl.customer_id
      LEFT JOIN users w ON w.id = cl.worker_id ${whereSql}`, params))!.c;
    const rows = await all(`${CALL_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);

    list(res, rows.map(shapeCall), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ CREATE ------------------------------ */

const createCallSchema = z.object({
  lead_id: z.number().int().positive().optional().nullable(),
  customer_id: z.number().int().positive().optional().nullable(),
  worker_id: z.number().int().positive().optional().nullable(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).default('OUTBOUND'),
  phone_number: z.string().trim().max(40).optional().nullable(),
  status: z.enum(['RINGING', 'ANSWERED', 'MISSED', 'BUSY', 'FAILED', 'NO_ANSWER', 'COMPLETED']).default('COMPLETED'),
  started_at: z.string().trim().max(40).optional().nullable(),
  answered_at: z.string().trim().max(40).optional().nullable(),
  ended_at: z.string().trim().max(40).optional().nullable(),
  duration_seconds: z.number().int().min(0).max(86400 * 7).optional().nullable(),
  disposition: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  provider: z.string().trim().max(40).optional(),
  provider_call_id: z.string().trim().max(120).optional().nullable(),
});

callsRouter.post('/', requireAuth, requirePermission('calls:create'), async (req, res, next) => {
  try {
    const body = meta(createCallSchema, req.body);
    const user = currentUser(req);
    const { leadId, customerId } = await resolveTargets(req, body);

    let workerId = user.id;
    if (body.worker_id && body.worker_id !== user.id) {
      if (!can(req, 'calls:read_all')) throw forbidden('You cannot log calls for another worker.');
      const target = await get<{ status: string }>('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL', [body.worker_id]);
      if (!target) throw badRequest('Selected worker does not exist.');
      if (target.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');
      workerId = body.worker_id;
    }

    const policy = await callPolicy();
    const now = await nowISO();
    const startedAt = body.started_at ?? (body.status === 'RINGING' ? null : now);
    const provider = body.provider ?? 'manual';

    if (body.provider_call_id) {
      const clash = await get<{ id: number }>('SELECT id FROM calls WHERE provider = ? AND provider_call_id = ?', [
        provider,
        body.provider_call_id,
      ]);
      if (clash) throw conflict('A call with this provider reference already exists.', { existing_id: clash.id });
    }

    const id = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, answered_at, ended_at, duration_seconds, status, disposition, notes, consent, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        customerId,
        workerId,
        provider,
        body.provider_call_id ?? null,
        body.direction,
        await phoneForTargets(leadId, customerId, body.phone_number),
        startedAt,
        body.answered_at ?? null,
        body.ended_at ?? null,
        body.duration_seconds ?? null,
        body.status,
        body.disposition ?? null,
        body.notes ?? null,
        policy.recording_mode === 'DO_NOT_RECORD'
          ? 'OPTED_OUT'
          : policy.recording_mode === 'RECORD'
            ? 'NOTICE_SHOWN'
            : 'PROVIDER_DEFAULT',
        user.id,
        now,
        now,
      ],
    )).lastInsertRowid;

    await finalizeCallCreation({ id, leadId, status: body.status, req, actorName: user.name });

    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    created(res, shapeCall(row!));
  } catch (err) {
    next(err);
  }
});

/** Shared side effects for both manual creation and webhook-created calls. */
export async function finalizeCallCreation(opts: {
  id: number;
  leadId: number | null;
  status: string;
  req?: any;
  actorName?: string;
  actorId?: number;
}): Promise<void> {
  const { id, leadId, status } = opts;
  const type =
    status === 'MISSED' || status === 'NO_ANSWER'
      ? TIMELINE_TYPES.CALL_MISSED
      : status === 'RINGING'
        ? TIMELINE_TYPES.CALL_INITIATED
        : TIMELINE_TYPES.CALL_LOGGED;

  if (leadId) {
    await addTimelineEvent({
      leadId,
      type,
      actorId: opts.actorId ?? opts.req?.user?.id ?? null,
      summary:
        type === TIMELINE_TYPES.CALL_MISSED
          ? `Call missed (${status})`
          : type === TIMELINE_TYPES.CALL_INITIATED
            ? 'Call initiated'
            : `Call ${status.toLowerCase()} (${status})`,
      metadata: { call_id: id, status },
    });

    if (status === 'COMPLETED' || status === 'ANSWERED') {
      await run('UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?', [await nowISO(), await nowISO(), leadId]);
    }
  }

  await audit(opts.req, 'CALL_CREATED', 'call', id, { status, lead_id: leadId });

  // Missed inbound calls are worth notifying the owner about.
  if (status === 'MISSED' && leadId) {
    const lead = await get<{ assigned_to: number | null; lead_number: string }>(
      'SELECT assigned_to, lead_number FROM leads WHERE id = ?',
      [leadId],
    );
    if (lead?.assigned_to) {
      await notify({
        userId: lead.assigned_to,
        type: 'CALL_MISSED',
        title: `Missed call: ${lead.lead_number}`,
        body: `${opts.actorName ?? 'A worker'} missed a call.`,
        entity: 'lead',
        entityId: leadId,
        link: `/leads/${leadId}`,
      });
    }
  }
}

/* ------------------------------ DETAIL ------------------------------ */

callsRouter.get('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadCall(id, req);
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    if (!row) throw notFound('Call not found.');
    ok(res, shapeCall(row));
  } catch (err) {
    next(err);
  }
});

const patchCallSchema = z
  .object({
    status: z.enum(['RINGING', 'ANSWERED', 'MISSED', 'BUSY', 'FAILED', 'NO_ANSWER', 'COMPLETED']).optional(),
    disposition: z.string().trim().max(60).optional().nullable(),
    notes: z.string().trim().max(4000).optional().nullable(),
    duration_seconds: z.number().int().min(0).max(86400 * 7).optional().nullable(),
    answered_at: z.string().trim().max(40).optional().nullable(),
    ended_at: z.string().trim().max(40).optional().nullable(),
  })
  .partial();

callsRouter.patch('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(patchCallSchema, req.body);

    const fields: string[] = [];
    const params: unknown[] = [];
    for (const key of ['status', 'disposition', 'notes', 'duration_seconds', 'answered_at', 'ended_at'] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (!fields.length) throw badRequest('No changes supplied.');
    fields.push('updated_at = ?');
    params.push(await nowISO(), id);
    await run(`UPDATE calls SET ${fields.join(', ')} WHERE id = ?`, params);

    await audit(req, 'CALL_UPDATED', 'call', id, { ...body });
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    ok(res, shapeCall(row!));
  } catch (err) {
    next(err);
  }
});

/* ---------------------- CALL → NEXT ACTION -------------------------- */

const nextActionSchema = z.object({
  disposition: z.string().trim().max(60).optional(),
  customer_response: z.string().trim().max(2000).optional().nullable(),
  next_action: z.string().trim().max(500).optional().nullable(),
  lead_status: z.string().trim().max(40).optional().nullable(),
  add_note: z.string().trim().max(4000).optional().nullable(),
  follow_up: z
    .object({
      scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
      scheduled_time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format').optional().nullable(),
      type: z.string().trim().max(40).default('Call'),
      notes: z.string().trim().max(2000).optional().nullable(),
    })
    .optional()
    .nullable(),
});

/**
 * The fast post-call workflow: outcome → response → next action → follow-up.
 * Workers run this dozens of times a day, so it is one request.
 */
callsRouter.post('/:id(\\d+)/next-action', requireAuth, requirePermission('calls:create'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(nextActionSchema, req.body);
    const user = currentUser(req);

    const leadId = call.lead_id;
    if (!leadId && body.follow_up) throw badRequest('Attach the call to a lead before scheduling a follow-up.');

    const result: Record<string, unknown> = {};

    if (body.disposition !== undefined || body.customer_response !== undefined) {
      const notes = [body.disposition ? `Disposition: ${body.disposition}` : '', body.customer_response ?? '']
        .filter(Boolean)
        .join('\n');
      const existing = call.notes ? `${call.notes}\n` : '';
      await run('UPDATE calls SET disposition = COALESCE(?, disposition), notes = ?, updated_at = ? WHERE id = ?', [
        body.disposition ?? null,
        notes ? `${existing}${notes}` : call.notes,
        await nowISO(),
        id,
      ]);
      result.disposition = body.disposition ?? call.disposition;
    }

    if (body.add_note && leadId) {
      const noteId = (await run('INSERT INTO notes (lead_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        leadId,
        user.id,
        body.add_note,
        await nowISO(),
        await nowISO(),
      ])).lastInsertRowid;
      await addTimelineEvent({
        leadId,
        type: TIMELINE_TYPES.NOTE_ADDED,
        actorId: user.id,
        summary: 'Note added after call',
        metadata: { note_id: noteId, call_id: id },
      });
      await audit(req, 'NOTE_ADDED', 'note', noteId, { lead_id: leadId, call_id: id });
      result.note_id = noteId;
    }

    if (body.lead_status && leadId) {
      const change = await changeLeadStatus({ leadId, toCode: body.lead_status, actorId: user.id, remark: body.customer_response ?? 'Call outcome' });
      if (change) await audit(req, 'LEAD_STATUS_CHANGED', 'lead', leadId, { from: change.from, to: change.to, call_id: id });
      result.lead_status = change ? change.to : body.lead_status;
    }

    if (body.follow_up && leadId) {
      const fuId = await createFollowUpRecord({
        input: {
          lead_id: leadId,
          worker_id: call.worker_id,
          scheduled_date: body.follow_up.scheduled_date,
          scheduled_time: body.follow_up.scheduled_time ?? null,
          type: body.follow_up.type ?? 'Call',
          notes: body.follow_up.notes ?? body.customer_response ?? null,
          next_action: body.next_action ?? null,
          customer_response: body.customer_response ?? null,
        },
        user,
        canCrossAssign: can(req, 'follow_ups:update') || call.worker_id === user.id,
        canScheduleOnAnyLead: can(req, 'leads:read_all'),
        req,
      });
      await run('UPDATE calls SET follow_up_id = ?, updated_at = ? WHERE id = ?', [fuId, await nowISO(), id]);
      result.follow_up_id = fuId;
    }

    await audit(req, 'CALL_NEXT_ACTION', 'call', id, {
      disposition: body.disposition ?? null,
      has_follow_up: Boolean(body.follow_up),
      lead_status: body.lead_status ?? null,
    });

    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    ok(res, { call: shapeCall(row!), ...result });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- PROVIDER ------------------------------ */

/** Places a call through the configured business telephony provider. */
callsRouter.post('/initiate', requireAuth, requirePermission('calls:create'), async (req, res, next) => {
  try {
    const body = meta(
      z.object({
        lead_id: z.number().int().positive().optional().nullable(),
        customer_id: z.number().int().positive().optional().nullable(),
        phone_number: z.string().trim().max(40).optional().nullable(),
      }),
      req.body,
    );
    const user = currentUser(req);
    const { leadId, customerId } = await resolveTargets(req, body);
    const phone = await phoneForTargets(leadId, customerId, body.phone_number);
    if (!phone) throw badRequest('No phone number available for this lead or customer.');

    const provider = await getTelephonyProvider();
    const result = await provider.initiateCall({
      toNumber: phone,
      workerId: user.id,
      leadId,
      customerId,
    });

    const policy = await callPolicy();
    const now = await nowISO();
    const id = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, status, consent, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OUTBOUND', ?, ?, 'RINGING', ?, ?, ?, ?)`,
      [
        leadId,
        customerId,
        user.id,
        result.provider,
        result.providerCallId,
        phone,
        now,
        policy.recording_mode === 'DO_NOT_RECORD' ? 'OPTED_OUT' : policy.recording_mode === 'RECORD' ? 'NOTICE_SHOWN' : 'PROVIDER_DEFAULT',
        user.id,
        now,
        now,
      ],
    )).lastInsertRowid;

    await finalizeCallCreation({ id, leadId, status: 'RINGING', req, actorName: user.name });
    await audit(req, 'CALL_INITIATED', 'call', id, { provider: result.provider, provider_call_id: result.providerCallId });

    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    created(res, shapeCall(row!));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- RECORDINGS ---------------------------- */

export async function loadRecording(callId: number) {
  return await get<any>(
    'SELECT * FROM call_recordings WHERE call_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    [callId],
  );
}

callsRouter.get('/:id(\\d+)/recording', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadCall(id, req);
    const rec = await loadRecording(id);
    if (!rec) {
      ok(res, { available: false, reason: 'No recording is attached to this call.' });
      return;
    }
    ok(res, {
      available: rec.status === 'AVAILABLE',
      status: rec.status,
      storage: rec.storage,
      duration_seconds: rec.duration_seconds,
      consent: rec.consent,
      retention_until: rec.retention_until,
      can_play: rec.status === 'AVAILABLE' && can(req, 'recordings:access'),
    });
  } catch (err) {
    next(err);
  }
});

/** Streams recording bytes — the provider's raw URL is never handed out. */
callsRouter.get('/:id(\\d+)/recording/stream', requireAuth, requirePermission('recordings:access'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    const rec = await loadRecording(id);
    if (!rec || rec.status !== 'AVAILABLE') throw notFound('Recording is not available.');
    if (rec.retention_until && rec.retention_until < todayStr()) {
      await run('UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', [
        'DELETED',
        await nowISO(),
        await nowISO(),
        rec.id,
      ]);
      throw notFound('This recording has passed the retention period.');
    }

    await audit(req, 'RECORDING_ACCESSED', 'call_recording', rec.id, { call_id: call.id, storage: rec.storage });

    if (rec.storage === 'provider') {
      const provider = await getTelephonyProvider();
      const ticket = await provider.fetchRecordingUrl(String(rec.provider_recording_id ?? rec.id));
      if (!ticket) throw notFound('The provider no longer has this recording.');
      const upstreamRes = await fetch(ticket.url, { signal: AbortSignal.timeout(20_000) });
      if (!upstreamRes.ok || !upstreamRes.body) throw notFound('The recording could not be fetched.');
      res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.setHeader('Content-Length', String(buf.length));
      res.end(buf);
      return;
    }

    const fs = await import('node:fs');
    const { recordingPath } = await import('../../services/documents.js');
    const file = recordingPath(String(rec.file_key ?? ''));
    if (!fs.existsSync(file)) throw notFound('The recording file is missing.');
    res.setHeader('Content-Type', rec.mime_type || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    next(err);
  }
});

const attachRecordingSchema = z.object({
  storage: z.enum(['provider', 'local']).default('provider'),
  provider_recording_id: z.string().trim().max(120).optional().nullable(),
  source_url: z.string().trim().max(2000).optional().nullable(),
  filename: z.string().trim().max(180).optional().nullable(),
  mime_type: z.string().trim().max(120).optional().nullable(),
  content_base64: z.string().max(14_000_000).optional().nullable(),
  duration_seconds: z.number().int().min(0).max(86400 * 7).optional().nullable(),
});

/** Upserts the recording row and runs the shared side effects. */
export async function attachRecordingToCall(opts: {
  call: CallRow;
  req: any;
  actorId: number | null;
  storage: 'provider' | 'local';
  fileKey: string | null;
  mime: string;
  providerRecordingId?: string | null;
  sourceUrl?: string | null;
  durationSeconds?: number | null;
}): Promise<{ id: number }> {
  const { call, req } = opts;
  const id = call.id;
  const now = await nowISO();
  const existing = await loadRecording(id);
  if (existing && existing.status === 'AVAILABLE') throw conflict('A recording is already attached to this call.');

  const retentionDays = (await retentionConfig()).call_recordings_days || (await callPolicy()).retention_days;
  const retentionUntil = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86400_000).toISOString().slice(0, 10) : null;

  let recId: number;
  if (existing) {
    recId = existing.id;
    await run(
      `UPDATE call_recordings SET status = 'AVAILABLE', storage = ?, provider_recording_id = ?, source_url = ?,
         file_key = ?, mime_type = ?, duration_seconds = ?, retention_until = ?, updated_at = ?, deleted_at = NULL
       WHERE id = ?`,
      [
        opts.storage,
        opts.providerRecordingId ?? null,
        opts.sourceUrl ?? null,
        opts.fileKey,
        opts.mime,
        opts.durationSeconds ?? null,
        retentionUntil,
        now,
        existing.id,
      ],
    );
  } else {
    recId = (await run(
      `INSERT INTO call_recordings (call_id, provider, provider_recording_id, storage, source_url, file_key,
         mime_type, duration_seconds, status, consent, retention_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?)`,
      [
        id,
        call.provider ?? 'manual',
        opts.providerRecordingId ?? null,
        opts.storage,
        opts.sourceUrl ?? null,
        opts.fileKey,
        opts.mime,
        opts.durationSeconds ?? null,
        call.consent ?? null,
        retentionUntil,
        now,
        now,
      ],
    )).lastInsertRowid;
  }

  await run('UPDATE calls SET recording_available = 1, updated_at = ? WHERE id = ?', [now, id]);
  if (call.lead_id) {
    await addTimelineEvent({
      leadId: call.lead_id,
      type: TIMELINE_TYPES.RECORDING_READY,
      actorId: opts.actorId,
      summary: 'Call recording is available',
      metadata: { call_id: id, recording_id: recId },
    });
  }
  await notify({
    userId: call.worker_id,
    type: 'CALL_RECORDING_READY',
    title: 'Call recording ready',
    body: `Recording available for ${call.phone_number ?? 'call'}${call.lead_number ? ` · ${call.lead_number}` : ''}.`,
    entity: 'call',
    entityId: id,
    link: call.lead_id ? `/leads/${call.lead_id}#calls` : undefined,
  });
  await audit(req, 'RECORDING_ATTACHED', 'call_recording', recId, { call_id: id, storage: opts.storage });
  return { id: recId };
}

callsRouter.post('/:id(\\d+)/recording', requireAuth, requirePermission('calls:create'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(attachRecordingSchema, req.body);
    const user = currentUser(req);

    let fileKey: string | null = null;
    let mime = body.mime_type ?? 'audio/mpeg';
    if (body.storage === 'local') {
      if (!body.content_base64) throw badRequest('Provide the recording content to upload.');
      const { parseBase64, saveRecordingFile } = await import('../../services/documents.js');
      const parsed = parseBase64(body.content_base64);
      if (parsed.mime) mime = parsed.mime;
      fileKey = saveRecordingFile(body.filename ?? `call-${id}`, mime, parsed.buffer);
    } else if (!body.source_url && !body.provider_recording_id) {
      throw badRequest('Provide a provider recording id or reference URL.');
    }

    const { id: recId } = await attachRecordingToCall({
      call,
      req,
      actorId: user.id,
      storage: body.storage,
      fileKey,
      mime,
      providerRecordingId: body.provider_recording_id ?? null,
      sourceUrl: body.source_url ?? null,
      durationSeconds: body.duration_seconds ?? null,
    });

    created(res, { id: recId, available: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Raw-body upload for larger local recordings (the app-wide JSON parser is
 * capped at 1 MB, so audio is posted as `audio/*` bytes instead of base64).
 */
callsRouter.post(
  '/:id(\\d+)/recording/file',
  requireAuth,
  requirePermission('calls:create'),
  raw({ type: ['audio/*', 'video/mp4', 'application/octet-stream'], limit: '64mb' }),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const call = await loadCall(id, req);
      assertCallWriteAccess(call, req);
      const user = currentUser(req);

      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!content.length) throw badRequest('No recording bytes were received.');
      const mime = String(req.header('x-mime-type') || 'audio/mpeg').slice(0, 120);
      const filename = String(req.header('x-filename') || `call-${id}.bin`).slice(0, 180);
      const durationHeader = Number(req.header('x-duration-seconds'));
      const duration = Number.isFinite(durationHeader) && durationHeader >= 0 ? Math.trunc(durationHeader) : null;

      const { saveRecordingFile } = await import('../../services/documents.js');
      const fileKey = saveRecordingFile(filename, mime, content);

      const { id: recId } = await attachRecordingToCall({
        call,
        req,
        actorId: user.id,
        storage: 'local',
        fileKey,
        mime,
        durationSeconds: duration,
      });

      created(res, { id: recId, available: true, size_bytes: content.length });
    } catch (err) {
      next(err);
    }
  },
);

callsRouter.delete('/:id(\\d+)/recording', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const rec = await loadRecording(id);
    if (!rec) throw notFound('No recording is attached to this call.');
    const now = await nowISO();
    await run('UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['DELETED', now, now, rec.id]);
    await run('UPDATE calls SET recording_available = 0, updated_at = ? WHERE id = ?', [now, id]);
    await audit(req, 'RECORDING_DELETED', 'call_recording', rec.id, { call_id: id });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- QUICK LEAD LINKED STATS --------------------- */

/** Compact call stats used by dashboards and lead headers. */
callsRouter.get('/stats/summary', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const requestedWorker = Number(req.query.worker_id) || 0;
    const scopeAll = String(req.query.scope ?? '') === 'all';
    // Admins may ask for one worker or the whole team; everyone else sees their own calls.
    const workerId = can(req, 'calls:read_all')
      ? requestedWorker || (scopeAll ? 0 : user.id)
      : user.id;
    const workerClause = workerId ? 'AND worker_id = ?' : '';
    const workerParams = workerId ? [workerId] : [];

    const dates = resolvePeriodDates(String(req.query.period ?? '').trim() || 'today', undefined, undefined);
    const from = dates.from ?? todayStr();
    const to = dates.to ?? todayStr();

    const rows = (await get<any>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS answered,
         SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
         SUM(CASE WHEN status IN ('RINGING','BUSY','FAILED') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN direction = 'OUTBOUND' THEN 1 ELSE 0 END) AS outbound,
         SUM(CASE WHEN direction = 'INBOUND' THEN 1 ELSE 0 END) AS inbound,
         SUM(COALESCE(duration_seconds, 0)) AS total_seconds
       FROM calls
       WHERE deleted_at IS NULL
         ${workerClause}
         AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      [...workerParams, from, to],
    ))!;

    const connected = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM calls WHERE deleted_at IS NULL
         ${workerClause}
         AND status IN ('ANSWERED','COMPLETED') AND COALESCE(duration_seconds,0) > 0
         AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      [...workerParams, from, to],
    ))!.c;

    ok(res, {
      period: { from, to },
      total: Number(rows.total ?? 0),
      answered: Number(rows.answered ?? 0),
      missed: Number(rows.missed ?? 0),
      failed: Number(rows.failed ?? 0),
      outbound: Number(rows.outbound ?? 0),
      inbound: Number(rows.inbound ?? 0),
      connected,
      total_seconds: Number(rows.total_seconds ?? 0),
    });
  } catch (err) {
    next(err);
  }
});
