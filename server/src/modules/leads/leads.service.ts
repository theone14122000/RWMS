import { all, get, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { todayStr } from '../../lib/dates.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { notify } from '../../services/notify.js';

export const TERMINAL_FOLLOW_UP_STATUSES = ['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED'];

/** SQL expression that resolves a stored follow-up status to its effective status. */
export function effectiveFuStatus(statusCol: string, dateCol: string): { sql: string; params: unknown[] } {
  const today = todayStr();
  return {
    sql: `CASE WHEN ${statusCol} IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED') THEN ${statusCol}
               WHEN ${dateCol} < ? THEN 'OVERDUE'
               WHEN ${dateCol} = ? THEN 'TODAY'
               ELSE ${statusCol} END`,
    params: [today, today],
  };
}

/** SQL expression that buckets an effective follow-up status into a board column. */
export function boardColumn(statusCol: string, dateCol: string): { sql: string; params: unknown[] } {
  const eff = effectiveFuStatus(statusCol, dateCol);
  return {
    sql: `CASE
      WHEN ${eff.sql} = 'COMPLETED' THEN 'COMPLETED'
      WHEN ${eff.sql} = 'CONVERTED' THEN 'CONVERTED'
      WHEN ${eff.sql} IN ('NOT_INTERESTED','CANCELLED') THEN 'NOT_INTERESTED'
      WHEN ${eff.sql} = 'OVERDUE' THEN 'OVERDUE'
      WHEN ${eff.sql} = 'TODAY' THEN 'TODAY'
      ELSE 'PENDING' END`,
    params: [...eff.params, ...eff.params],
  };
}

export interface LeadRow {
  id: number;
  lead_number: string;
  customer_id: number;
  assigned_to: number | null;
  status_id: number;
  deleted_at?: string | null;
  [key: string]: any;
}

/** Fetches a lead and enforces server-side access for the caller. */
export async function loadLead(leadId: number, req: { user?: { id: number; permissions: string[] } }): Promise<LeadRow> {
  const lead = await get<LeadRow>('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
  if (!lead) throw notFound('Lead not found.');
  const user = req.user;
  if (!user) throw forbidden();
  const isAdmin = user.permissions.includes('leads:read_all');
  if (!isAdmin && lead.assigned_to !== user.id) {
    throw forbidden('You do not have access to this lead.');
  }
  return lead;
}

export function assertLeadWriteAccess(lead: LeadRow, req: { user?: { id: number; permissions: string[] } }): void {
  const user = req.user;
  if (!user) throw forbidden();
  if (user.permissions.includes('leads:update')) return;
  if (user.permissions.includes('leads:update_own') && lead.assigned_to === user.id) return;
  throw forbidden('You do not have permission to modify this lead.');
}

export async function nextLeadNumber(): Promise<string> {
  const prefix = await get<{ value: string }>('SELECT value FROM settings WHERE setting_key = ?', ['lead_number_prefix']);
  const base = safeJson(prefix?.value, 'LD') as string;
  const stamp = new Date().toISOString().slice(0, 7).replace('-', '');
  const pattern = `${base}-${stamp}-%`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await get<{ n: number }>(
      `SELECT COALESCE(MAX(CAST(substr(lead_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM leads WHERE lead_number LIKE ?`,
      [`${base}-${stamp}-`, pattern],
    );
    const next = (row?.n ?? 0) + 1 + attempt;
    const candidate = `${base}-${stamp}-${String(next).padStart(4, '0')}`;
    const clash = await get('SELECT id FROM leads WHERE lead_number = ?', [candidate]);
    if (!clash) return candidate;
  }
  return `${base}-${stamp}-${Date.now().toString().slice(-6)}`;
}

function safeJson(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export interface AssignOptions {
  lead: LeadRow;
  toUserId: number | null;
  actorId: number;
  actorName: string;
  reason?: string | null;
}

export interface AssignResult {
  changed: boolean;
  from: number | null;
  to: number | null;
}

/** Assigns / reassigns a lead while preserving the full assignment history. */
export async function assignLead(opts: AssignOptions): Promise<AssignResult> {
  const { lead, toUserId, actorId } = opts;
  const from = lead.assigned_to;

  if ((from ?? null) === (toUserId ?? null)) return { changed: false, from, to: toUserId };

  if (toUserId !== null) {
    const target = await get<{ id: number; name: string; status: string }>(
      'SELECT id, name, status FROM users WHERE id = ? AND deleted_at IS NULL',
      [toUserId],
    );
    if (!target) throw badRequest('Selected worker does not exist.');
    if (target.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');
  }

  const now = await nowISO();

  await run('UPDATE lead_assignments SET is_active = 0, released_at = ? WHERE lead_id = ? AND is_active = 1', [
    now,
    lead.id,
  ]);

  if (toUserId !== null) {
    await run(
      `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, action, reason, assigned_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        lead.id,
        toUserId,
        actorId,
        from ? 'REASSIGNED' : 'ASSIGNED',
        opts.reason ?? null,
        now,
      ],
    );
  }

  await run('UPDATE leads SET assigned_to = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
    toUserId,
    now,
    actorId,
    lead.id,
  ]);

  const type = toUserId === null ? TIMELINE_TYPES.UNASSIGNED : from ? TIMELINE_TYPES.REASSIGNED : TIMELINE_TYPES.ASSIGNED;
  const targetName =
    toUserId === null
      ? 'Unassigned'
      : (await get<{ name: string }>('SELECT name FROM users WHERE id = ?', [toUserId]))?.name ?? `#${toUserId}`;
  const fromName = from ? ((await get<{ name: string }>('SELECT name FROM users WHERE id = ?', [from]))?.name ?? `#${from}`) : 'Unassigned';

  await addTimelineEvent({
    leadId: lead.id,
    type,
    actorId,
    summary:
      type === TIMELINE_TYPES.UNASSIGNED
        ? `Lead unassigned from ${fromName}`
        : from
          ? `Reassigned from ${fromName} to ${targetName}`
          : `Assigned to ${targetName}`,
    metadata: { from, to: toUserId, from_name: fromName, to_name: targetName, reason: opts.reason ?? null },
  });

  if (toUserId !== null && toUserId !== actorId) {
    await notify({
      userId: toUserId,
      type: 'LEAD_ASSIGNED',
      title: `New lead assigned: ${lead.lead_number}`,
      body: opts.reason ? `Reason: ${opts.reason}` : `${opts.actorName} assigned a lead to you.`,
      entity: 'lead',
      entityId: lead.id,
      link: `/leads/${lead.id}`,
    });
  }

  // Auto-promote NEW leads to ASSIGNED so the pipeline reflects reality.
  const status = await get<{ code: string }>('SELECT code FROM lead_statuses WHERE id = ?', [lead.status_id]);
  if (toUserId !== null && status?.code === 'NEW') {
    await changeLeadStatus({ leadId: lead.id, toCode: 'ASSIGNED', actorId, silent: false });
  }

  return { changed: true, from, to: toUserId };
}

export interface StatusChangeOptions {
  leadId: number;
  toCode: string;
  actorId: number;
  remark?: string | null;
  silent?: boolean;
}

export async function changeLeadStatus(opts: StatusChangeOptions): Promise<{ from: string; to: string } | null> {
  const lead = await get<LeadRow>('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [opts.leadId]);
  if (!lead) throw notFound('Lead not found.');

  const to = await get<{ id: number; code: string; is_active: number }>(
    'SELECT id, code, is_active FROM lead_statuses WHERE code = ?',
    [opts.toCode],
  );
  if (!to) throw badRequest('Unknown lead status.');
  if (to.is_active !== 1) throw badRequest('This lead status is disabled.');

  const current = await get<{ id: number; code: string }>('SELECT id, code FROM lead_statuses WHERE id = ?', [lead.status_id]);
  if (!current || current.id === to.id) return null;

  const now = await nowISO();
  await run('UPDATE leads SET status_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
    to.id,
    now,
    opts.actorId,
    opts.leadId,
  ]);
  await run(
    'INSERT INTO lead_status_history (lead_id, from_status_id, to_status_id, changed_by, remark, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    [opts.leadId, current.id, to.id, opts.actorId, opts.remark ?? null, now],
  );
  await addTimelineEvent({
    leadId: opts.leadId,
    type: TIMELINE_TYPES.STATUS_CHANGED,
    actorId: opts.actorId,
    summary: `Status changed from ${current.code} to ${to.code}`,
    metadata: { from: current.code, to: to.code, remark: opts.remark ?? null },
  });

  return { from: current.code, to: to.code };
}

export function shapeLead(row: Record<string, any>): Record<string, any> {
  let requirements: unknown = [];
  let customFields: unknown = {};
  try {
    requirements = JSON.parse(row.requirements ?? '[]');
  } catch {
    requirements = [];
  }
  try {
    customFields = JSON.parse(row.custom_fields ?? '{}');
  } catch {
    customFields = {};
  }

  const today = todayStr();
  const openFuDate: string | null = row.next_fu_date ?? null;
  const openFuStatus = row.next_fu_status ?? null;

  let effectiveFu: string | null = null;
  if (openFuStatus && openFuDate) {
    if (TERMINAL_FOLLOW_UP_STATUSES.includes(openFuStatus)) effectiveFu = openFuStatus;
    else if (openFuDate < today) effectiveFu = 'OVERDUE';
    else if (openFuDate === today) effectiveFu = 'TODAY';
    else effectiveFu = openFuStatus;
  }

  return {
    id: row.id,
    lead_number: row.lead_number,
    customer: row.customer_id
      ? {
          id: row.customer_id,
          name: row.customer_name,
          phone: row.customer_phone,
          whatsapp: row.customer_whatsapp,
          email: row.customer_email,
          city: row.customer_city,
        }
      : null,
    source: row.source_id ? { id: row.source_id, name: row.source_name } : null,
    assignee: row.assigned_to ? { id: row.assigned_to, name: row.assignee_name, status: row.assignee_status } : null,
    destination: row.destination,
    travel_type: row.travel_type,
    trip_type: row.trip_type,
    requirements,
    travel_start_date: row.travel_start_date,
    travel_end_date: row.travel_end_date,
    duration_days: row.duration_days,
    adults: row.adults,
    children: row.children,
    total_travelers: row.total_travelers,
    budget: row.budget,
    currency: row.currency,
    priority: row.priority,
    status: row.status_code
      ? {
          id: row.status_id,
          code: row.status_code,
          name: row.status_name,
          category: row.status_category,
          color: row.status_color,
        }
      : null,
    last_contacted_at: row.last_contacted_at,
    next_follow_up_at: row.next_follow_up_at,
    next_follow_up_date: openFuDate,
    next_follow_up_status: effectiveFu,
    overdue_follow_ups: Number(row.overdue_follow_ups ?? 0),
    open_follow_ups: Number(row.open_follow_ups ?? 0),
    notes: row.notes,
    custom_fields: customFields,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Fields workers are not allowed to change directly on a lead. */
export const ADMIN_ONLY_LEAD_FIELDS = ['customer_id', 'source_id', 'assigned_to', 'lead_number'] as const;

export { all, get, run };

/** Shared row shape used by lead detail + follow-up payloads. */
export function shapeFollowUp(row: Record<string, any>): Record<string, any> {
  const today = todayStr();
  const status = row.status;
  const date = row.scheduled_date;
  let effective = status;
  if (!['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED'].includes(status)) {
    if (date < today) effective = 'OVERDUE';
    else if (date === today) effective = 'TODAY';
  }
  let board = 'PENDING';
  if (effective === 'COMPLETED') board = 'COMPLETED';
  else if (effective === 'CONVERTED') board = 'CONVERTED';
  else if (effective === 'NOT_INTERESTED' || effective === 'CANCELLED') board = 'NOT_INTERESTED';
  else if (effective === 'OVERDUE') board = 'OVERDUE';
  else if (effective === 'TODAY') board = 'TODAY';

  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_number: row.lead_number,
    lead_priority: row.lead_priority,
    lead_status: row.lead_status_code,
    lead_status_name: row.lead_status_name,
    destination: row.destination,
    customer: row.customer_id
      ? { id: row.customer_id, name: row.customer_name, phone: row.customer_phone }
      : null,
    worker: row.worker_id ? { id: row.worker_id, name: row.worker_name } : null,
    scheduled_date: row.scheduled_date,
    scheduled_time: row.scheduled_time,
    type: row.type,
    status,
    effective_status: effective,
    board_column: board,
    notes: row.notes,
    customer_response: row.customer_response,
    next_action: row.next_action,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    completed_by: row.completed_by,
    completed_by_name: row.completed_by_name,
    created_at: row.created_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}
