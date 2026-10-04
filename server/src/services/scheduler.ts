import { all, get, nowISO, run, tx } from '../db/database.js';
import { addDays, todayStr } from '../lib/dates.js';
import { auditAs } from './audit.js';
import { notify } from './notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from './timeline.js';
import { callPolicy, readSetting, reminderConfig, retentionConfig, writeSetting } from './settings.js';

/**
 * Backend automation. All state transitions here are derived from the
 * database (never from browser timers) and are idempotent: reminder columns
 * guarantee a follow-up is reminded at most once per day/phase.
 */

export interface AutomationRun {
  due_reminders: number;
  overdue_reminders: number;
  quotations_expired: number;
  recordings_expired: number;
  ran_at: string;
}

const TERMINAL_SQL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;

export function notifyDueFollowUps(): number {
  const { enabled } = reminderConfig();
  if (!enabled) return 0;
  const today = todayStr();
  const rows = all<{ id: number; worker_id: number; lead_id: number; scheduled_date: string; lead_number: string; customer_name: string }>(
    `SELECT f.id, f.worker_id, f.lead_id, f.scheduled_date, l.lead_number, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
        AND f.status NOT IN ${TERMINAL_SQL}
        AND f.scheduled_date = ?
        AND f.reminder_sent_at IS NULL
      ORDER BY f.scheduled_date ASC, f.scheduled_time ASC
      LIMIT 200`,
    [today],
  );
  let count = 0;
  for (const row of rows) {
    notify({
      userId: row.worker_id,
      type: 'FOLLOW_UP_DUE',
      title: `Follow-up due today: ${row.lead_number}`,
      body: `${row.customer_name} · scheduled ${row.scheduled_date}`,
      entity: 'follow_up',
      entityId: row.id,
      link: `/follow-ups?lead_id=${row.lead_id}`,
    });
    run('UPDATE follow_ups SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL', [nowISO(), row.id]);
    count += 1;
  }
  return count;
}

export function notifyOverdueFollowUps(): number {
  const { overdue_enabled } = reminderConfig();
  if (!overdue_enabled) return 0;
  const today = todayStr();
  const rows = all<{ id: number; worker_id: number; lead_id: number; scheduled_date: string; lead_number: string; customer_name: string }>(
    `SELECT f.id, f.worker_id, f.lead_id, f.scheduled_date, l.lead_number, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
        AND f.status NOT IN ${TERMINAL_SQL}
        AND f.scheduled_date < ?
        AND f.overdue_reminder_sent_at IS NULL
      ORDER BY f.scheduled_date ASC
      LIMIT 200`,
    [today],
  );
  let count = 0;
  for (const row of rows) {
    notify({
      userId: row.worker_id,
      type: 'FOLLOW_UP_OVERDUE',
      title: `Overdue follow-up: ${row.lead_number}`,
      body: `${row.customer_name} · was due ${row.scheduled_date}`,
      entity: 'follow_up',
      entityId: row.id,
      link: `/follow-ups?lead_id=${row.lead_id}`,
    });
    run('UPDATE follow_ups SET overdue_reminder_sent_at = ? WHERE id = ? AND overdue_reminder_sent_at IS NULL', [
      nowISO(),
      row.id,
    ]);
    count += 1;
  }
  return count;
}

/** Marks quotations past their validity date as EXPIRED (idempotent). */
export function expireQuotations(): number {
  const today = todayStr();
  const rows = all<{ id: number; lead_id: number; quotation_number: string; created_by: number | null }>(
    `SELECT id, lead_id, quotation_number, created_by FROM quotations
      WHERE deleted_at IS NULL AND valid_until IS NOT NULL AND valid_until < ?
        AND status IN ('SENT','VIEWED','NEGOTIATION')`,
    [today],
  );
  if (!rows.length) return 0;
  const now = nowISO();
  tx(() => {
    for (const row of rows) {
      const history = appendStatusHistory(row.id, 'EXPIRED', row.created_by);
      run(`UPDATE quotations SET status = 'EXPIRED', status_history = ?, updated_at = ? WHERE id = ?`, [
        history,
        now,
        row.id,
      ]);
      addTimelineEvent({
        leadId: row.lead_id,
        type: TIMELINE_TYPES.QUOTATION_EXPIRED,
        actorId: row.created_by,
        summary: `Quotation ${row.quotation_number} expired`,
        metadata: { quotation_id: row.id },
      });
      if (row.created_by) {
        notify({
          userId: row.created_by,
          type: 'QUOTATION_EXPIRED',
          title: `Quotation expired: ${row.quotation_number}`,
          body: 'The validity date has passed.',
          entity: 'quotation',
          entityId: row.id,
          link: `/quotations?lead_id=${row.lead_id}`,
        });
      }
    }
  });
  return rows.length;
}

function pushHistoryEntry(current: string, entry: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(current ?? '[]');
    const list = Array.isArray(parsed) ? parsed : [];
    list.push(entry);
    return JSON.stringify(list.slice(-50));
  } catch {
    return JSON.stringify([entry]);
  }
}

/** Appends a status transition to the quotation's own status history. */
function appendStatusHistory(quotationId: number, toStatus: string, actorId: number | null): string {
  const row = get<{ status_history: string; status: string }>('SELECT status_history, status FROM quotations WHERE id = ?', [
    quotationId,
  ]);
  return pushHistoryEntry(row?.status_history ?? '[]', {
    from: row?.status,
    to: toStatus,
    actor_id: actorId,
    at: nowISO(),
    source: 'automation',
  });
}

/** Applies configured retention rules to recordings/documents/communications. */
export function applyRetention(): { recordings: number; documents: number; communications: number } {
  const cfg = retentionConfig();
  const now = nowISO();
  const today = todayStr();
  let recordings = 0;
  let documents = 0;
  let communications = 0;

  if (cfg.call_recordings_days > 0) {
    const cutoff = addDays(today, -cfg.call_recordings_days);
    const rows = all<{ id: number; call_id: number }>(
      'SELECT id, call_id FROM call_recordings WHERE deleted_at IS NULL AND (retention_until IS NULL OR retention_until < ?)',
      [cutoff],
    );
    for (const row of rows) {
      run('UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['DELETED', now, now, row.id]);
      run('UPDATE calls SET recording_available = 0, updated_at = ? WHERE id = ?', [now, row.call_id]);
      recordings += 1;
    }
    if (recordings) auditAs(null, 'RETENTION_APPLIED', 'call_recording', null, { count: recordings, cutoff });
  }

  if (cfg.documents_days > 0) {
    const cutoff = addDays(today, -cfg.documents_days);
    const rows = all<{ id: number }>('SELECT id FROM documents WHERE deleted_at IS NULL AND created_at < ?', [
      `${cutoff}T00:00:00.000Z`,
    ]);
    for (const row of rows) run('UPDATE documents SET deleted_at = ? WHERE id = ?', [now, row.id]);
    documents = rows.length;
    if (documents) auditAs(null, 'RETENTION_APPLIED', 'document', null, { count: documents, cutoff });
  }

  if (cfg.communications_days > 0) {
    const cutoff = addDays(today, -cfg.communications_days);
    const rows = all<{ id: number }>('SELECT id FROM communications WHERE deleted_at IS NULL AND created_at < ?', [
      `${cutoff}T00:00:00.000Z`,
    ]);
    for (const row of rows) run('UPDATE communications SET deleted_at = ? WHERE id = ?', [now, row.id]);
    communications = rows.length;
    if (communications) auditAs(null, 'RETENTION_APPLIED', 'communication', null, { count: communications, cutoff });
  }

  return { recordings, documents, communications };
}

/** One deterministic automation pass — called by the timer and by tests. */
export function runAutomationOnce(): AutomationRun {
  const ran: AutomationRun = {
    due_reminders: 0,
    overdue_reminders: 0,
    quotations_expired: 0,
    recordings_expired: 0,
    ran_at: nowISO(),
  };
  try {
    ran.due_reminders = notifyDueFollowUps();
    ran.overdue_reminders = notifyOverdueFollowUps();
    ran.quotations_expired = expireQuotations();
    applyRecordingRetention();
  } catch (err) {
    console.error('[automation] run failed', err);
  }
  writeSetting('automation_last_run', ran);
  return ran;
}

/** Recording retention uses the per-recording retention_until (policy aware). */
function applyRecordingRetention(): number {
  const policyRetention = callPolicy().retention_days;
  const now = nowISO();
  const rows = all<{ id: number; call_id: number }>(
    `SELECT id, call_id FROM call_recordings
      WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < ?`,
    [now.slice(0, 10)],
  );
  if (!rows.length) return 0;
  for (const row of rows) {
    run('UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?', ['DELETED', now, now, row.id]);
    run('UPDATE calls SET recording_available = 0, updated_at = ? WHERE id = ?', [now, row.call_id]);
  }
  auditAs(null, 'RETENTION_APPLIED', 'call_recording', null, { count: rows.length, policy_days: policyRetention });
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background automation loop (never started in tests). */
export function startScheduler(intervalMs = 60_000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => runAutomationOnce(), intervalMs);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function automationStatus(): { last_run: unknown; scheduler_enabled: boolean; reminders: unknown } {
  return {
    last_run: readSetting('automation_last_run', null),
    scheduler_enabled: Boolean(timer),
    reminders: reminderConfig(),
  };
}

/** Small helper used by routes that need "is this follow-up overdue today". */
export function isOverdue(scheduledDate: string): boolean {
  return scheduledDate < todayStr();
}
