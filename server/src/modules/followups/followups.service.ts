import type { Request } from 'express';
import { get, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { shapeFollowUp } from '../leads/leads.service.js';

export const FU_SELECT = `
  SELECT f.*, l.lead_number, l.destination, l.priority AS lead_priority, l.assigned_to AS lead_assignee,
         ls.code AS lead_status_code, ls.name AS lead_status_name,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name, w.id AS worker_id,
         cb.name AS created_by_name, comp.name AS completed_by_name
  FROM follow_ups f
  JOIN leads l ON l.id = f.lead_id
  JOIN customers c ON c.id = l.customer_id
  JOIN lead_statuses ls ON ls.id = l.status_id
  JOIN users w ON w.id = f.worker_id
  LEFT JOIN users cb ON cb.id = f.created_by
  LEFT JOIN users comp ON comp.id = f.completed_by`;

export interface CreateFollowUpInput {
  lead_id: number;
  worker_id?: number;
  scheduled_date: string;
  scheduled_time?: string | null;
  type: string;
  notes?: string | null;
  next_action?: string | null;
  customer_response?: string | null;
}

/**
 * Single creation path used by the follow-up API and by the call → follow-up
 * workflow, so validation, timeline, audit and notifications behave the same
 * wherever a follow-up comes from.
 */
export async function createFollowUpRecord(opts: {
  input: CreateFollowUpInput;
  user: { id: number; name: string };
  canCrossAssign: boolean;
  canScheduleOnAnyLead: boolean;
  req?: Request;
}): Promise<number> {
  const { input, user } = opts;
  const lead = await get<{ id: number; assigned_to: number | null; lead_number: string }>(
    `SELECT l.id, l.assigned_to, l.lead_number FROM leads l
      WHERE l.id = ? AND l.deleted_at IS NULL`,
    [input.lead_id],
  );
  if (!lead) throw notFound('Lead not found.');
  if (!opts.canScheduleOnAnyLead && lead.assigned_to !== user.id) {
    throw forbidden('You can only schedule follow-ups on your own leads.');
  }

  let workerId = input.worker_id ?? user.id;
  if (workerId !== user.id && !opts.canCrossAssign) {
    throw forbidden('You cannot assign follow-ups to another worker.');
  }
  const worker = await get<{ id: number; status: string }>('SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL', [
    workerId,
  ]);
  if (!worker) throw badRequest('Selected worker does not exist.');
  if (worker.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');

  const now = await nowISO();
  const id = (await run(
    `INSERT INTO follow_ups (lead_id, worker_id, scheduled_date, scheduled_time, type, status, notes, next_action,
      customer_response, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
    [
      input.lead_id,
      workerId,
      input.scheduled_date,
      input.scheduled_time ?? null,
      input.type,
      input.notes ?? null,
      input.next_action ?? null,
      input.customer_response ?? null,
      user.id,
      now,
      now,
    ],
  )).lastInsertRowid;

  await addTimelineEvent({
    leadId: input.lead_id,
    type: TIMELINE_TYPES.FOLLOW_UP_CREATED,
    actorId: user.id,
    summary: `Follow-up scheduled for ${input.scheduled_date}${input.scheduled_time ? ` ${input.scheduled_time}` : ''} (${input.type})`,
    metadata: { follow_up_id: id, worker_id: workerId, type: input.type },
  });
  await audit(opts.req, 'FOLLOW_UP_CREATED', 'follow_up', id, {
    lead_id: input.lead_id,
    worker_id: workerId,
    scheduled_date: input.scheduled_date,
  });

  if (workerId !== user.id) {
    await notify({
      userId: workerId,
      type: 'FOLLOW_UP_ASSIGNED',
      title: `Follow-up scheduled: ${lead.lead_number}`,
      body: `${user.name} scheduled a follow-up for ${input.scheduled_date}.`,
      entity: 'follow_up',
      entityId: id,
      link: `/leads/${input.lead_id}`,
    });
  }

  return id;
}

export async function shapedFollowUpById(id: number): Promise<Record<string, any> | undefined> {
  const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
  return row ? shapeFollowUp(row) : undefined;
}
