import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { resolvePeriodDates } from '../../lib/dates.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { channelStatus, sendCommunication, type Channel } from '../../services/communications.js';

export const communicationsRouter = Router();

const CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS', 'IN_APP'] as const;

function shapeMessage(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    provider: row.provider ?? null,
    sender_id: row.sender_id ?? null,
    sender_name: row.sender_name ?? null,
    recipient: row.recipient,
    customer_id: row.customer_id ?? null,
    customer_name: row.customer_name ?? null,
    lead_id: row.lead_id ?? null,
    lead_number: row.lead_number ?? null,
    worker_id: row.worker_id ?? null,
    worker_name: row.worker_name ?? null,
    subject: row.subject ?? null,
    body: row.body ?? null,
    status: row.status,
    error: row.error ?? null,
    sent_at: row.sent_at ?? null,
    delivered_at: row.delivered_at ?? null,
    created_at: row.created_at,
  };
}

const MSG_SELECT = `
  SELECT m.*, s.name AS sender_name, c.name AS customer_name, l.lead_number, w.name AS worker_name
  FROM communications m
  LEFT JOIN users s ON s.id = m.sender_id
  LEFT JOIN customers c ON c.id = m.customer_id
  LEFT JOIN leads l ON l.id = m.lead_id
  LEFT JOIN users w ON w.id = m.worker_id`;

/* -------------------------------- LIST -------------------------------- */

communicationsRouter.get('/', requireAuth, requirePermission('communications:read'), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where: string[] = ['m.deleted_at IS NULL'];
    const params: unknown[] = [];

    // Workers see messages tied to their own records; anything else is admin scope.
    if (!can(req, 'leads:read_all')) {
      where.push(
        '(m.worker_id = ? OR m.sender_id = ? OR m.lead_id IN (SELECT id FROM leads WHERE assigned_to = ? AND deleted_at IS NULL))',
      );
      params.push(user.id, user.id, user.id);
    }

    const channels = toArray(req.query.channel);
    if (channels.length) {
      where.push(`m.channel IN (${channels.map(() => '?').join(',')})`);
      params.push(...channels);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`m.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push('m.lead_id = ?');
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push('m.customer_id = ?');
      params.push(customerId);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(`(m.recipient LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\')`);
      const term = await likeTerm(search);
      params.push(term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? '').trim() || undefined,
      String(req.query.date_from ?? '').trim() || undefined,
      String(req.query.date_to ?? '').trim() || undefined,
    );
    if (dates.from) {
      where.push('substr(m.created_at, 1, 10) >= ?');
      params.push(dates.from);
    }
    if (dates.to) {
      where.push('substr(m.created_at, 1, 10) <= ?');
      params.push(dates.to);
    }

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM communications m
         LEFT JOIN customers c ON c.id = m.customer_id
         LEFT JOIN leads l ON l.id = m.lead_id
         LEFT JOIN users w ON w.id = m.worker_id
         LEFT JOIN users s ON s.id = m.sender_id ${whereSql}`,
      params,
    ))!.c;
    const rows = await all(`${MSG_SELECT} ${whereSql} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    list(res, rows.map(shapeMessage), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- CHANNELS ----------------------------- */

/** Which channels are actually wired up — the UI never fakes availability. */
communicationsRouter.get('/channels', requireAuth, requirePermission('communications:read'), async (_req, res, next) => {
  try {
    ok(res, {
      whatsapp: await channelStatus('WHATSAPP'),
      email: await channelStatus('EMAIL'),
      sms: await channelStatus('SMS'),
      in_app: { configured: true, provider: 'internal', base_url: '', secret_present: false },
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- SEND -------------------------------- */

const sendSchema = z
  .object({
    channel: z.enum(CHANNELS),
    lead_id: z.number().int().positive().optional().nullable(),
    customer_id: z.number().int().positive().optional().nullable(),
    worker_id: z.number().int().positive().optional().nullable(),
    recipient: z.string().trim().max(200).optional().nullable(),
    subject: z.string().trim().max(300).optional().nullable(),
    body: z.string().trim().min(1).max(4000),
  })
  .refine((v) => Boolean(v.lead_id || v.customer_id || v.worker_id || v.recipient), {
    message: 'Provide lead_id, customer_id, worker_id, or an explicit recipient.',
  });

async function resolveRecipient(channel: string, input: any, req: any): Promise<string> {
  if (input.recipient) return input.recipient;
  if (channel === 'IN_APP') {
    const target = input.worker_id;
    if (!target) throw badRequest('IN_APP messages need a worker_id.');
    const user = await get<{ id: number; email: string | null }>('SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL', [
      target,
    ]);
    if (!user) throw notFound('Worker not found.');
    return user.email || `user-${target}`;
  }
  if (input.lead_id) {
    const lead = await get<{ phone: string | null; email: string | null }>(
      'SELECT c.phone, c.email FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?',
      [input.lead_id],
    );
    if (!lead) throw notFound('Lead not found.');
    const value = channel === 'EMAIL' ? lead.email : lead.phone;
    if (!value) {
      throw badRequest(
        channel === 'EMAIL' ? 'This customer has no email address.' : 'This customer has no phone number.',
      );
    }
    return value;
  }
  if (input.customer_id) {
    const customer = await get<{ phone: string | null; email: string | null }>(
      'SELECT phone, email FROM customers WHERE id = ? AND deleted_at IS NULL',
      [input.customer_id],
    );
    if (!customer) throw notFound('Customer not found.');
    const value = channel === 'EMAIL' ? customer.email : customer.phone;
    if (!value) {
      throw badRequest(
        channel === 'EMAIL' ? 'This customer has no email address.' : 'This customer has no phone number.',
      );
    }
    return value;
  }
  throw badRequest('No recipient could be resolved.');
}

communicationsRouter.post('/', requireAuth, requirePermission('communications:send'), async (req, res, next) => {
  try {
    const body = meta(sendSchema, req.body);
    const user = currentUser(req);

    // Access check when the message hangs off a lead/customer.
    if (body.lead_id) {
      const lead = await get<{ assigned_to: number | null }>(
        'SELECT assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL',
        [body.lead_id],
      );
      if (!lead) throw notFound('Lead not found.');
      if (!can(req, 'leads:read_all') && lead.assigned_to !== user.id) {
        throw forbidden('You do not have access to this lead.');
      }
    }
    if (body.customer_id && !can(req, 'leads:read_all') && !body.lead_id) {
      const owned = await get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL',
        [body.customer_id, user.id],
      );
      if (!owned?.c) throw forbidden('You do not have access to this customer.');
    }

    const recipient = await resolveRecipient(body.channel, body, req);

    if (body.channel === 'IN_APP') {
      const now = await nowISO();
      const targetWorker = body.worker_id!;
      const id = (await run(
        `INSERT INTO communications
           (channel, direction, provider, sender_id, recipient, customer_id, lead_id, worker_id, subject, body,
            status, sent_at, created_at, updated_at)
         VALUES ('IN_APP', 'OUTBOUND', 'internal', ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)`,
        [
          user.id,
          recipient,
          body.customer_id ?? null,
          body.lead_id ?? null,
          targetWorker,
          body.subject ?? null,
          body.body,
          now,
          now,
          now,
        ],
      )).lastInsertRowid;

      await notify({
        userId: targetWorker,
        type: 'MESSAGE_RECEIVED',
        title: body.subject || `Message from ${user.name}`,
        body: body.body.slice(0, 400),
        entity: body.lead_id ? 'lead' : 'customer',
        entityId: body.lead_id ?? body.customer_id ?? 0,
        link: body.lead_id ? `/leads/${body.lead_id}` : '/inbox',
      });

      await audit(req, 'MESSAGE_SENT', 'communication', id, { channel: 'IN_APP', recipient });
      if (body.lead_id) {
        await addTimelineEvent({
          leadId: body.lead_id,
          type: TIMELINE_TYPES.MESSAGE_SENT,
          actorId: user.id,
          summary: `In-app message sent to a worker`,
          metadata: { communication_id: id, channel: 'IN_APP' },
        });
      }
      const row = await get(`${MSG_SELECT} WHERE m.id = ?`, [id]);
      created(res, { ...shapeMessage(row!), configured: true, reason: null });
      return;
    }

    const result = await sendCommunication({
      channel: body.channel as Channel,
      recipient,
      body: body.body,
      subject: body.subject ?? null,
      senderId: user.id,
      leadId: body.lead_id ?? null,
      customerId: body.customer_id ?? null,
      workerId: body.worker_id ?? null,
    });

    await audit(req, 'MESSAGE_SENT', 'communication', result.id, {
      channel: body.channel,
      configured: result.configured,
      status: result.status,
    });

    if (body.lead_id) {
      await addTimelineEvent({
        leadId: body.lead_id,
        type: TIMELINE_TYPES.MESSAGE_SENT,
        actorId: user.id,
        summary: result.configured
          ? `${body.channel} message submitted to provider`
          : `${body.channel} message recorded (Integration Not Configured)`,
        metadata: { communication_id: result.id, channel: body.channel, status: result.status },
      });
    }

    const row = await get(`${MSG_SELECT} WHERE m.id = ?`, [result.id]);
    created(res, {
      ...shapeMessage(row!),
      configured: result.configured,
      reason: result.configured ? null : 'Integration Not Configured',
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- DETAIL ------------------------------ */

communicationsRouter.get('/:id(\\d+)', requireAuth, requirePermission('communications:read'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get(`${MSG_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`, [id]);
    if (!row) throw notFound('Message not found.');
    const user = currentUser(req);
    let allowed = can(req, 'leads:read_all') || row.worker_id === user.id || row.sender_id === user.id;
    if (!allowed && row.lead_id) {
      const lead = await get<{ assigned_to: number | null }>('SELECT assigned_to FROM leads WHERE id = ?', [row.lead_id]);
      allowed = lead?.assigned_to === user.id;
    }
    if (!allowed) throw forbidden('You do not have access to this message.');
    ok(res, shapeMessage(row));
  } catch (err) {
    next(err);
  }
});
