import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { all, get, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, HttpError, notConfigured } from '../../lib/errors.js';
import { buildMeta, list, meta, ok, pagination } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { callPolicy } from '../../services/settings.js';
import { WEBHOOK_SECRET_ENV } from '../../services/telephony.js';
import {
  attachRecordingToCall,
  finalizeCallCreation,
  getCallRow,
  loadRecording,
} from './calls.routes.js';

/**
 * Business-telephony webhook inbox.
 *
 * Auth: the shared secret lives in an environment variable (never in the DB).
 * Each delivery is idempotent through webhook_events(provider, event_id), so a
 * provider retrying the same event can never duplicate a call or recording.
 */
export const telephonyWebhooksRouter = Router();

const eventSchema = z
  .object({
    event_id: z.string().trim().min(1).max(120),
    event_type: z.string().trim().min(1).max(80),
    occurred_at: z.string().trim().max(40).optional(),
    worker_id: z.number().int().positive().optional(),
    lead_id: z.number().int().positive().optional(),
    customer_id: z.number().int().positive().optional(),
    call: z
      .object({
        provider_call_id: z.string().trim().min(1).max(120),
        direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
        phone_number: z.string().trim().max(40).optional().nullable(),
        status: z.string().trim().max(30).optional(),
        started_at: z.string().trim().max(40).optional().nullable(),
        answered_at: z.string().trim().max(40).optional().nullable(),
        ended_at: z.string().trim().max(40).optional().nullable(),
        duration_seconds: z.number().int().min(0).max(86400 * 7).optional().nullable(),
        disposition: z.string().trim().max(60).optional().nullable(),
      })
      .passthrough()
      .optional(),
    recording: z
      .object({
        provider_recording_id: z.string().trim().max(120).optional().nullable(),
        url: z.string().trim().max(2000).optional().nullable(),
        duration_seconds: z.number().int().min(0).max(86400 * 7).optional().nullable(),
      })
      .optional(),
  })
  .passthrough();

type WebhookEvent = z.infer<typeof eventSchema>;

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Accepts an HMAC signature over the raw body, or a plain shared token. */
function verifyWebhookAuth(req: any, rawBody: Buffer): void {
  const secret = process.env[WEBHOOK_SECRET_ENV];
  if (!secret) {
    throw notConfigured(
      `Webhook authentication is not configured. Set the ${WEBHOOK_SECRET_ENV} environment variable.`,
    );
  }

  const signature = String(req.headers['x-signature'] || req.headers['x-hub-signature-256'] || '');
  if (signature) {
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!timingSafeEquals(provided.toLowerCase(), expected.toLowerCase())) {
      throw forbidden('Invalid webhook signature.');
    }
    return;
  }

  const token = String(
    req.headers['x-webhook-secret'] ||
      (String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7)
        : '') ||
      req.query.secret ||
      '',
  );
  if (!token || !timingSafeEquals(token, secret)) throw forbidden('Invalid webhook secret.');
}

/** Maps a provider event name onto our call status vocabulary. */
function mapEventToStatus(eventType: string): string | null {
  const e = eventType.toLowerCase();
  if (e.includes('recording')) return null;
  if (e.includes('ring') || e.includes('initiat') || e.includes('dial')) return 'RINGING';
  if (e.includes('no_answer') || e.includes('noanswer')) return 'NO_ANSWER';
  if (e.includes('answer') || e.includes('pickup')) return 'ANSWERED';
  if (e.includes('miss')) return 'MISSED';
  if (e.includes('busy')) return 'BUSY';
  if (e.includes('fail') || e.includes('error') || e.includes('reject')) return 'FAILED';
  if (e.includes('completed') || e.includes('hangup') || e.includes('disconnect') || e.includes('end')) {
    return 'COMPLETED';
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // SQLite: "UNIQUE constraint failed"; PostgreSQL: SQLSTATE 23505.
  return /UNIQUE constraint failed/i.test(err.message) || (err as { code?: string }).code === '23505';
}

async function findCall(provider: string, providerCallId: string) {
  return await get<any>('SELECT * FROM calls WHERE provider = ? AND provider_call_id = ? AND deleted_at IS NULL', [
    provider,
    providerCallId,
  ]);
}

/** Resolves the worker a webhook-attributed call belongs to. */
async function resolveWorker(event: WebhookEvent): Promise<{ workerId: number; leadId: number | null }> {
  let leadId = event.lead_id ?? null;
  let workerId = event.worker_id ?? 0;

  if (leadId) {
    const lead = await get<{ assigned_to: number | null; customer_id: number }>(
      'SELECT assigned_to, customer_id FROM leads WHERE id = ? AND deleted_at IS NULL',
      [leadId],
    );
    if (!lead) throw badRequest(`Unknown lead_id ${leadId} on webhook event.`);
    workerId = workerId || lead.assigned_to || 0;
  } else if (event.customer_id) {
    // Attribute to the customer's most recent active lead when possible.
    const lead = await get<{ id: number; assigned_to: number | null }>(
      `SELECT id, assigned_to FROM leads WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(last_contacted_at, created_at) DESC, id DESC LIMIT 1`,
      [event.customer_id],
    );
    if (lead) {
      leadId = lead.id;
      workerId = workerId || lead.assigned_to || 0;
    }
  }

  if (!workerId) {
    throw badRequest('Cannot attribute this call: include worker_id or lead_id in the webhook payload.');
  }
  const worker = await get<{ id: number; status: string }>(
    'SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL',
    [workerId],
  );
  if (!worker) throw badRequest(`Worker ${workerId} does not exist.`);
  if (worker.status !== 'ACTIVE') throw badRequest(`Worker ${workerId} is not active.`);
  return { workerId, leadId };
}

interface ProcessResult {
  callId: number;
  action: string;
}

async function processEvent(provider: string, event: WebhookEvent, req: any): Promise<ProcessResult> {
  const callInfo = event.call;
  if (!callInfo && !event.recording) {
    throw badRequest('Webhook payload must include a call object.');
  }

  const providerCallId = callInfo?.provider_call_id;
  if (!providerCallId) throw badRequest('call.provider_call_id is required.');

  const incomingStatus = mapEventToStatus(event.event_type);
  const now = await nowISO();
  let call = await findCall(provider, providerCallId);
  let action: string;

  if (!call) {
    const { workerId, leadId } = await resolveWorker(event);
    const status = incomingStatus ?? callInfo?.status ?? 'COMPLETED';
    const policy = await callPolicy();
    const newId = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, answered_at, ended_at, duration_seconds, status, disposition, consent, webhook_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        event.customer_id ?? null,
        workerId,
        provider,
        providerCallId,
        callInfo?.direction ?? 'INBOUND',
        callInfo?.phone_number ?? null,
        callInfo?.started_at ?? event.occurred_at ?? now,
        callInfo?.answered_at ?? null,
        callInfo?.ended_at ?? null,
        callInfo?.duration_seconds ?? null,
        status,
        callInfo?.disposition ?? null,
        policy.recording_mode === 'DO_NOT_RECORD'
          ? 'OPTED_OUT'
          : policy.recording_mode === 'RECORD'
            ? 'NOTICE_SHOWN'
            : 'PROVIDER_DEFAULT',
        event.event_id,
        now,
        now,
      ],
    )).lastInsertRowid;
    await finalizeCallCreation({ id: newId, leadId, status, req, actorName: `Provider ${provider}` });
    call = await getCallRow(newId);
    action = 'call_created';
  } else if (incomingStatus && incomingStatus !== call.status) {
    await run(
      `UPDATE calls SET status = ?, answered_at = COALESCE(?, answered_at), ended_at = COALESCE(?, ended_at),
         duration_seconds = COALESCE(?, duration_seconds), disposition = COALESCE(?, disposition),
         webhook_event_id = ?, updated_at = ? WHERE id = ?`,
      [
        incomingStatus,
        callInfo?.answered_at ?? (incomingStatus === 'ANSWERED' ? now : null),
        callInfo?.ended_at ?? null,
        callInfo?.duration_seconds ?? null,
        callInfo?.disposition ?? null,
        event.event_id,
        now,
        call.id,
      ],
    );
    await emitCallOutcome({ callId: call.id, leadId: call.lead_id, status: incomingStatus, req, actorName: `Provider ${provider}` });
    call = await getCallRow(call.id);
    action = 'call_updated';
  } else if (callInfo) {
    await run(
      `UPDATE calls SET answered_at = COALESCE(?, answered_at), ended_at = COALESCE(?, ended_at),
         duration_seconds = COALESCE(?, duration_seconds), disposition = COALESCE(?, disposition),
         webhook_event_id = ?, updated_at = ? WHERE id = ?`,
      [
        callInfo.answered_at ?? null,
        callInfo.ended_at ?? null,
        callInfo.duration_seconds ?? null,
        callInfo.disposition ?? null,
        event.event_id,
        now,
        call.id,
      ],
    );
    action = 'call_updated';
  } else {
    action = 'call_unchanged';
  }

  if (event.event_type.toLowerCase().includes('recording')) {
    if (!event.recording) throw badRequest('recording payload is required for recording events.');
    const existing = await loadRecording(call.id);
    if (!existing || existing.status !== 'AVAILABLE') {
      await attachRecordingToCall({
        call,
        req,
        actorId: null,
        storage: 'provider',
        fileKey: null,
        mime: 'audio/mpeg',
        providerRecordingId: event.recording.provider_recording_id ?? event.recording.url ?? null,
        sourceUrl: event.recording.url ?? null,
        durationSeconds: event.recording.duration_seconds ?? null,
      });
      action = 'recording_attached';
    } else {
      action = 'recording_already_attached';
    }
  }

  return { callId: call.id, action };
}

/** Timeline/notify side effects when a status transition arrives from a provider. */
async function emitCallOutcome(opts: {
  callId: number;
  leadId: number | null;
  status: string;
  req?: any;
  actorName?: string;
}): Promise<void> {
  const { callId, leadId, status } = opts;
  if (!leadId) return;
  const type =
    status === 'MISSED' || status === 'NO_ANSWER'
      ? TIMELINE_TYPES.CALL_MISSED
      : status === 'RINGING'
        ? TIMELINE_TYPES.CALL_INITIATED
        : TIMELINE_TYPES.CALL_COMPLETED;

  await addTimelineEvent({
    leadId,
    type,
    actorId: null,
    summary: `Call ${status.toLowerCase()} (provider event)`,
    metadata: { call_id: callId, status, source: 'provider_webhook' },
  });

  if (status === 'COMPLETED' || status === 'ANSWERED') {
    await run('UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?', [await nowISO(), await nowISO(), leadId]);
  }

  if (status === 'MISSED') {
    const lead = await get<{ assigned_to: number | null; lead_number: string }>(
      'SELECT assigned_to, lead_number FROM leads WHERE id = ?',
      [leadId],
    );
    if (lead?.assigned_to) {
      await notify({
        userId: lead.assigned_to,
        type: 'CALL_MISSED',
        title: `Missed call: ${lead.lead_number}`,
        body: `${opts.actorName ?? 'A provider'} reported a missed call.`,
        entity: 'lead',
        entityId: leadId,
        link: `/leads/${leadId}`,
      });
    }
  }
}

telephonyWebhooksRouter.post('/telephony/:provider', async (req, res, next) => {
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw badRequest('Invalid provider code.');

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    verifyWebhookAuth(req, rawBody);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw badRequest('Webhook body must be valid JSON.');
    }
    const event = meta(eventSchema, payload);

    const now = await nowISO();
    let eventRowId: number;
    try {
      eventRowId = (await run(
        `INSERT INTO webhook_events (provider, event_id, event_type, signature, status, payload, received_at, created_at)
         VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`,
        [
          provider,
          event.event_id,
          event.event_type,
          String(req.headers['x-signature'] || req.headers['x-webhook-secret'] ? 'signature' : 'secret'),
          JSON.stringify(event),
          now,
          now,
        ],
      )).lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = await get<{ id: number; status: string; call_id: number | null }>(
          'SELECT id, status, call_id FROM webhook_events WHERE provider = ? AND event_id = ?',
          [provider, event.event_id],
        );
        ok(res, { duplicate: true, id: dup?.id ?? null, status: dup?.status ?? 'DUPLICATE' });
        return;
      }
      throw err;
    }

    try {
      const result = await processEvent(provider, event, req);
      await run('UPDATE webhook_events SET status = ?, call_id = ?, processed_at = ? WHERE id = ?', [
        'PROCESSED',
        result.callId,
        await nowISO(),
        eventRowId,
      ]);
      await audit(req, 'WEBHOOK_PROCESSED', 'webhook_event', eventRowId, {
        provider,
        event_type: event.event_type,
        call_id: result.callId,
        action: result.action,
      });
      ok(res, { ok: true, call_id: result.callId, action: result.action });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Processing failed.';
      await run('UPDATE webhook_events SET status = ?, error = ?, processed_at = ? WHERE id = ?', [
        'FAILED',
        message,
        await nowISO(),
        eventRowId,
      ]);
      // Validation/attribution problems are permanent: acknowledge so the
      // provider stops retrying; the event stays visible in the inbox.
      if (err instanceof HttpError && err.status < 500) {
        ok(res, { ok: false, error: message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** Webhook inbox — lets the admin see exactly what a provider sent and why. */
telephonyWebhooksRouter.get('/telephony/events', requireAuth, requirePermission('calls:read_all'), async (req, res, next) => {
  try {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    const provider = String(req.query.provider ?? '').trim();
    if (provider) {
      where.push('provider = ?');
      params.push(provider);
    }
    const statuses = Array.isArray(req.query.status)
      ? (req.query.status as string[])
      : typeof req.query.status === 'string' && req.query.status
        ? [req.query.status]
        : [];
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(`(event_id LIKE ? OR event_type LIKE ? OR provider LIKE ?)`);
      const term = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      params.push(term, term, term);
    }

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(`SELECT COUNT(*) AS c FROM webhook_events ${whereSql}`, params))!.c;
    const rows = await all(
      `SELECT id, provider, event_id, event_type, status, error, call_id, received_at, processed_at, created_at
       FROM webhook_events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    list(res, rows, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
