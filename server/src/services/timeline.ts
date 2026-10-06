import { nowISO, run } from '../db/database.js';

/**
 * Canonical lead event names. The list is intentionally open-ended so Part 2
 * (calls, recordings, quotations, bookings) can append new types without
 * touching the timeline schema.
 */
export const TIMELINE_TYPES = {
  LEAD_CREATED: 'LEAD_CREATED',
  LEAD_UPDATED: 'LEAD_UPDATED',
  ASSIGNED: 'ASSIGNED',
  REASSIGNED: 'REASSIGNED',
  UNASSIGNED: 'UNASSIGNED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  NOTE_ADDED: 'NOTE_ADDED',
  FOLLOW_UP_CREATED: 'FOLLOW_UP_CREATED',
  FOLLOW_UP_UPDATED: 'FOLLOW_UP_UPDATED',
  FOLLOW_UP_COMPLETED: 'FOLLOW_UP_COMPLETED',
  CUSTOMER_UPDATED: 'CUSTOMER_UPDATED',
  // ---- Part 2 ----
  LEAD_VIEWED: 'LEAD_VIEWED',
  CALL_INITIATED: 'CALL_INITIATED',
  CALL_COMPLETED: 'CALL_COMPLETED',
  CALL_MISSED: 'CALL_MISSED',
  CALL_LOGGED: 'CALL_LOGGED',
  RECORDING_READY: 'RECORDING_READY',
  RECORDING_ACCESSED: 'RECORDING_ACCESSED',
  QUOTATION_CREATED: 'QUOTATION_CREATED',
  QUOTATION_SENT: 'QUOTATION_SENT',
  QUOTATION_STATUS_CHANGED: 'QUOTATION_STATUS_CHANGED',
  QUOTATION_EXPIRED: 'QUOTATION_EXPIRED',
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_STATUS_CHANGED: 'BOOKING_STATUS_CHANGED',
  CUSTOMER_MERGED: 'CUSTOMER_MERGED',
  LEAD_MERGED: 'LEAD_MERGED',
  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  LEAD_IMPORTED: 'LEAD_IMPORTED',
  AI_SUMMARY_GENERATED: 'AI_SUMMARY_GENERATED',
} as const;

export type TimelineType = (typeof TIMELINE_TYPES)[keyof typeof TIMELINE_TYPES] | string;

export interface TimelineInput {
  leadId: number;
  type: TimelineType;
  actorId?: number | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function addTimelineEvent(input: TimelineInput): Promise<number> {
  const res = await run(
    'INSERT INTO lead_timeline (lead_id, type, actor_id, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      input.leadId,
      input.type,
      input.actorId ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      await nowISO(),
    ],
  );
  return res.lastInsertRowid;
}
