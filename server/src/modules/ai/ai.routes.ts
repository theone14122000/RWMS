import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../../db/database.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { meta, ok } from '../../lib/http.js';
import { currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { aiStatus, getAiProvider } from '../../services/ai.js';

export const aiRouter = Router();

aiRouter.get('/status', requireAuth, requirePermission('ai:use'), (_req, res, next) => {
  try {
    ok(res, aiStatus());
  } catch (err) {
    next(err);
  }
});

function leadContext(leadId: number): { promptData: string; lead: any } {
  const lead = get<any>(
    `SELECT l.*, ls.code AS status_code, ls.name AS status_name, c.name AS customer_name, c.phone AS customer_phone,
            c.email AS customer_email, src.name AS source_name, w.name AS worker_name
     FROM leads l
     JOIN customers c ON c.id = l.customer_id
     JOIN lead_statuses ls ON ls.id = l.status_id
     LEFT JOIN lead_sources src ON src.id = l.source_id
     LEFT JOIN users w ON w.id = l.assigned_to
     WHERE l.id = ? AND l.deleted_at IS NULL`,
    [leadId],
  );
  if (!lead) throw notFound('Lead not found.');

  const followUps = all<any>(
    `SELECT f.scheduled_date, f.scheduled_time, f.type, f.status, f.notes, f.next_action, f.customer_response, w.name AS worker
     FROM follow_ups f JOIN users w ON w.id = f.worker_id
     WHERE f.lead_id = ? ORDER BY f.scheduled_date DESC, f.id DESC LIMIT 10`,
    [leadId],
  );
  const calls = all<any>(
    `SELECT cl.direction, cl.status, cl.duration_seconds, cl.started_at, cl.disposition, cl.notes, w.name AS worker
     FROM calls cl LEFT JOIN users w ON w.id = cl.worker_id
     WHERE cl.lead_id = ? AND cl.deleted_at IS NULL
     ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 10`,
    [leadId],
  );
  const notes = all<any>(
    `SELECT n.content, n.created_at, u.name AS author FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.lead_id = ? AND n.deleted_at IS NULL ORDER BY n.id DESC LIMIT 10`,
    [leadId],
  );
  const quotations = all<any>(
    `SELECT quotation_number, status, total_amount, currency, valid_until FROM quotations
     WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
    [leadId],
  );

  const promptData = [
    `Lead: ${lead.lead_number} | Customer: ${lead.customer_name} (${lead.customer_phone ?? 'no phone'})`,
    `Status: ${lead.status_code} | Priority: ${lead.priority} | Source: ${lead.source_name ?? 'unknown'} | Owner: ${lead.worker_name ?? 'unassigned'}`,
    `Destination: ${lead.destination ?? 'unset'} | Trip: ${lead.trip_type ?? '-'} | Travel: ${lead.travel_start_date ?? '?'} → ${lead.travel_end_date ?? '?'} | Budget: ${lead.budget ?? 'unset'} ${lead.currency}`,
    `Requirements: ${lead.requirements}`,
    `Notes: ${lead.notes ?? '-'}`,
    followUps.length
      ? `Recent follow-ups:\n${followUps
          .map(
            (f) =>
              `- ${f.scheduled_date} ${f.scheduled_time ?? ''} ${f.type} [${f.status}] by ${f.worker}: ${f.notes ?? ''}${f.customer_response ? ` | response: ${f.customer_response}` : ''}`,
          )
          .join('\n')}`
      : 'Recent follow-ups: none',
    calls.length
      ? `Recent calls:\n${calls
          .map(
            (c) =>
              `- ${c.started_at ?? '-'} ${c.direction} ${c.status} ${c.duration_seconds ?? 0}s by ${c.worker ?? '-'}: ${c.disposition ?? ''} ${c.notes ?? ''}`,
          )
          .join('\n')}`
      : 'Recent calls: none',
    quotations.length
      ? `Quotations:\n${quotations
          .map((q) => `- ${q.quotation_number} ${q.status} ${q.currency} ${q.total_amount} valid until ${q.valid_until ?? '-'}`)
          .join('\n')}`
      : 'Quotations: none',
    notes.length
      ? `Notes:\n${notes.map((n) => `- (${n.created_at}, ${n.author ?? '-'}) ${n.content}`).join('\n')}`
      : 'Notes: none',
  ].join('\n');

  return { promptData, lead };
}

/**
 * Draft lead summary. Unconfigured → honest `{configured:false}` payload;
 * configured → a *draft* for the worker to review — nothing is saved.
 */
aiRouter.post('/summary', requireAuth, requirePermission('ai:use'), async (req, res, next) => {
  try {
    const body = meta(z.object({ lead_id: z.number().int().positive() }), req.body);
    const status = aiStatus();
    if (!status.configured) {
      ok(res, { configured: false, reason: status.reason ?? 'Integration Not Configured', draft: null });
      return;
    }

    const { promptData, lead } = leadContext(body.lead_id);
    const provider = getAiProvider();
    const draft = await provider.complete(
      [
        'You are a concise travel-agency CRM assistant.',
        'Summarise the lead for the assigned worker: current situation, customer intent,',
        'what happened so far, risks, and the recommended next action.',
        'Use short bullet points. Do not invent facts that are not in the data.',
        'Max 150 words. This is a draft for human review.',
      ].join(' '),
      promptData,
    );

    const user = currentUser(req);
    audit(req, 'AI_SUMMARY_DRAFTED', 'lead', body.lead_id, { provider: provider.code, model: provider.model });
    addTimelineEvent({
      leadId: body.lead_id,
      type: TIMELINE_TYPES.AI_SUMMARY_GENERATED,
      actorId: user.id,
      summary: 'AI draft summary generated (not saved)',
      metadata: { provider: provider.code, model: provider.model },
    });

    ok(res, { configured: true, reason: null, draft, provider: provider.code, model: provider.model });
  } catch (err) {
    next(err);
  }
});

/** Drafts an outbound message for a lead — the worker still hits send. */
aiRouter.post('/message-draft', requireAuth, requirePermission('ai:use'), async (req, res, next) => {
  try {
    const body = meta(
      z.object({
        lead_id: z.number().int().positive(),
        channel: z.enum(['WHATSAPP', 'EMAIL', 'SMS', 'IN_APP']).default('WHATSAPP'),
        purpose: z.string().trim().max(200).optional().nullable(),
      }),
      req.body,
    );
    const status = aiStatus();
    if (!status.configured) {
      ok(res, { configured: false, reason: status.reason ?? 'Integration Not Configured', draft: null });
      return;
    }

    const { promptData } = leadContext(body.lead_id);
    const provider = getAiProvider();
    const draft = await provider.complete(
      [
        `Draft a friendly ${body.channel} message from a travel agency to this customer.`,
        body.purpose ? `Purpose: ${body.purpose}.` : 'Purpose: follow up on the enquiry.',
        'Tone: warm, professional, max 80 words, no placeholders like [NAME].',
        'Return only the message text.',
      ].join(' '),
      promptData,
    );

    const user = currentUser(req);
    audit(req, 'AI_MESSAGE_DRAFTED', 'lead', body.lead_id, {
      provider: provider.code,
      channel: body.channel,
    });
    ok(res, { configured: true, reason: null, draft, provider: provider.code, model: provider.model });
  } catch (err) {
    next(err);
  }
});
