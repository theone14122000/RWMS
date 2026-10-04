import { Router } from 'express';
import { z } from 'zod';
import { all, get, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';

export const duplicatesRouter = Router();

const DECISIONS = ['KEPT_SEPARATE', 'MERGED', 'LINKED', 'IGNORED'] as const;

function normalizePhone(value: string | null | undefined): string {
  const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.slice(0, 15);
}

function shapeReview(row: Record<string, any>): Record<string, any> {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata ?? '{}');
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entity_id,
    candidate_id: row.candidate_id,
    reason: row.reason ?? null,
    score: row.score ?? null,
    status: row.status,
    decided_by: row.decided_by ?? null,
    decided_at: row.decided_at ?? null,
    metadata,
    entity_data: row.entity_data ?? null,
    candidate_data: row.candidate_data ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function reviewExists(entity: string, a: number, b: number): boolean {
  const row = get<{ id: number }>(
    `SELECT id FROM duplicate_reviews
     WHERE entity = ? AND ((entity_id = ? AND candidate_id = ?) OR (entity_id = ? AND candidate_id = ?))
       AND status IN ('OPEN','LINKED')`,
    [entity, a, b, b, a],
  );
  return Boolean(row);
}

/* -------------------------------- SCAN -------------------------------- */

/**
 * Finds candidate duplicates: customers sharing a phone number and open leads
 * sharing customer + destination. Existing open reviews are never duplicated.
 */
duplicatesRouter.post('/scan', requireAuth, requirePermission('leads:read_all'), (req, res, next) => {
  try {
    const now = nowISO();
    let customersFound = 0;
    let leadsFound = 0;

    const byPhone = new Map<string, Array<{ id: number; name: string }>>();
    for (const row of all<{ id: number; name: string; phone: string | null }>(
      'SELECT id, name, phone FROM customers WHERE deleted_at IS NULL AND phone IS NOT NULL',
    )) {
      const key = normalizePhone(row.phone);
      if (key.length < 7) continue;
      const group = byPhone.get(key) ?? [];
      group.push({ id: row.id, name: row.name });
      byPhone.set(key, group);
    }
    for (const [phone, group] of byPhone) {
      if (group.length < 2) continue;
      const base = group[0];
      for (const other of group.slice(1)) {
        if (reviewExists('CUSTOMER', other.id, base.id)) continue;
        run(
          `INSERT INTO duplicate_reviews (entity, entity_id, candidate_id, reason, score, status, metadata, created_at, updated_at)
           VALUES ('CUSTOMER', ?, ?, 'Same phone number', 'HIGH', 'OPEN', ?, ?, ?)`,
          [other.id, base.id, JSON.stringify({ phone }), now, now],
        );
        customersFound += 1;
      }
    }

    const leadGroups = new Map<string, Array<{ id: number; lead_number: string }>>();
    for (const row of all<{ id: number; lead_number: string; customer_id: number; destination: string | null; status: string }>(
      `SELECT l.id, l.lead_number, l.customer_id, l.destination, ls.code AS status
       FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
       WHERE l.deleted_at IS NULL AND ls.category = 'OPEN'`,
    )) {
      const key = `${row.customer_id}::${String(row.destination ?? '').trim().toLowerCase()}`;
      if (!row.destination) continue;
      const group = leadGroups.get(key) ?? [];
      group.push({ id: row.id, lead_number: row.lead_number });
      leadGroups.set(key, group);
    }
    for (const [, group] of leadGroups) {
      if (group.length < 2) continue;
      const base = group[0];
      for (const other of group.slice(1)) {
        if (reviewExists('LEAD', other.id, base.id)) continue;
        run(
          `INSERT INTO duplicate_reviews (entity, entity_id, candidate_id, reason, score, status, metadata, created_at, updated_at)
           VALUES ('LEAD', ?, ?, 'Same customer and destination', 'MEDIUM', 'OPEN', '{}', ?, ?)`,
          [other.id, base.id, now, now],
        );
        leadsFound += 1;
      }
    }

    audit(req, 'DUPLICATES_SCANNED', 'duplicate_review', null, { customers: customersFound, leads: leadsFound });
    created(res, { customers_found: customersFound, leads_found: leadsFound });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- LIST -------------------------------- */

duplicatesRouter.get('/', requireAuth, requirePermission('leads:read_all'), (req, res, next) => {
  try {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`d.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else {
      where.push(`d.status = 'OPEN'`);
    }
    const entities = toArray(req.query.entity);
    if (entities.length) {
      where.push(`d.entity IN (${entities.map(() => '?').join(',')})`);
      params.push(...entities);
    }

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM duplicate_reviews d ${whereSql}`, params)!.c;
    const rows = all(`SELECT d.* FROM duplicate_reviews d ${whereSql} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);

    const hydrated = rows.map((row: any) => {
      let entityData: unknown = null;
      let candidateData: unknown = null;
      if (row.entity === 'CUSTOMER') {
        entityData = get('SELECT id, name, phone, email, city, created_at FROM customers WHERE id = ?', [row.entity_id]);
        candidateData = get('SELECT id, name, phone, email, city, created_at FROM customers WHERE id = ?', [
          row.candidate_id,
        ]);
      } else {
        entityData = get(
          `SELECT l.id, l.lead_number, l.destination, c.name AS customer_name, ls.code AS status, l.created_at
           FROM leads l JOIN customers c ON c.id = l.customer_id JOIN lead_statuses ls ON ls.id = l.status_id
           WHERE l.id = ?`,
          [row.entity_id],
        );
        candidateData = get(
          `SELECT l.id, l.lead_number, l.destination, c.name AS customer_name, ls.code AS status, l.created_at
           FROM leads l JOIN customers c ON c.id = l.customer_id JOIN lead_statuses ls ON ls.id = l.status_id
           WHERE l.id = ?`,
          [row.candidate_id],
        );
      }
      return shapeReview({ ...row, entity_data: entityData, candidate_data: candidateData });
    });

    list(res, hydrated, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DECIDE ------------------------------ */

const decideSchema = z.object({
  action: z.enum(DECISIONS),
  target_id: z.number().int().positive().optional(),
  remark: z.string().trim().max(500).optional().nullable(),
});

function mergeCustomers(sourceId: number, targetId: number, req: any): Record<string, number> {
  if (sourceId === targetId) throw badRequest('A customer cannot be merged into itself.');
  const now = nowISO();
  const counts: Record<string, number> = {};

  counts.leads = run('UPDATE leads SET customer_id = ?, updated_at = ? WHERE customer_id = ? AND deleted_at IS NULL', [
    targetId,
    now,
    sourceId,
  ]).changes;
  counts.calls = run('UPDATE calls SET customer_id = ? WHERE customer_id = ?', [targetId, sourceId]).changes;
  counts.quotations = run('UPDATE quotations SET customer_id = ? WHERE customer_id = ?', [targetId, sourceId]).changes;
  counts.bookings = run('UPDATE bookings SET customer_id = ? WHERE customer_id = ?', [targetId, sourceId]).changes;
  counts.communications = run('UPDATE communications SET customer_id = ? WHERE customer_id = ?', [targetId, sourceId])
    .changes;
  counts.documents = run(`UPDATE documents SET entity_id = ? WHERE entity = 'CUSTOMER' AND entity_id = ?`, [
    targetId,
    sourceId,
  ]).changes;

  // Keep target data, but fill blanks from the source record.
  const target = get<any>('SELECT * FROM customers WHERE id = ?', [targetId]);
  const source = get<any>('SELECT * FROM customers WHERE id = ?', [sourceId]);
  if (target && source) {
    const patch: string[] = [];
    const params: unknown[] = [];
    for (const field of ['phone', 'whatsapp', 'email', 'city', 'state', 'country', 'notes'] as const) {
      if (!target[field] && source[field]) {
        patch.push(`${field} = ?`);
        params.push(source[field]);
      }
    }
    if (patch.length) {
      patch.push('updated_at = ?');
      params.push(now, targetId);
      run(`UPDATE customers SET ${patch.join(', ')} WHERE id = ?`, params);
    }
  }

  run('UPDATE customers SET deleted_at = ?, merged_into_id = ?, updated_at = ? WHERE id = ?', [
    now,
    targetId,
    now,
    sourceId,
  ]);
  return counts;
}

function mergeLeads(sourceId: number, targetId: number, actorId: number): Record<string, number> {
  if (sourceId === targetId) throw badRequest('A lead cannot be merged into itself.');
  const now = nowISO();
  const counts: Record<string, number> = {};
  counts.follow_ups = run('UPDATE follow_ups SET lead_id = ? WHERE lead_id = ?', [targetId, sourceId]).changes;
  counts.notes = run('UPDATE notes SET lead_id = ? WHERE lead_id = ?', [targetId, sourceId]).changes;
  counts.calls = run('UPDATE calls SET lead_id = ? WHERE lead_id = ?', [targetId, sourceId]).changes;
  counts.timeline = run('UPDATE lead_timeline SET lead_id = ? WHERE lead_id = ?', [targetId, sourceId]).changes;
  run('UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, sourceId]);

  const dupNumber = get<{ lead_number: string }>('SELECT lead_number FROM leads WHERE id = ?', [sourceId]);
  addTimelineEvent({
    leadId: targetId,
    type: TIMELINE_TYPES.LEAD_MERGED,
    actorId,
    summary: `Merged duplicate lead ${dupNumber?.lead_number ?? sourceId}`,
    metadata: { merged_lead_id: sourceId },
  });
  return counts;
}

duplicatesRouter.post('/:id(\\d+)/decide', requireAuth, requirePermission('leads:read_all'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = meta(decideSchema, req.body);
    const user = currentUser(req);

    const review = get<any>('SELECT * FROM duplicate_reviews WHERE id = ?', [id]);
    if (!review) throw notFound('Duplicate review not found.');
    if (review.status !== 'OPEN') throw conflict(`This review is already ${review.status.toLowerCase()}.`);

    const now = nowISO();
    let counts: Record<string, number> | null = null;

    if (body.action === 'MERGED') {
      if (!req.user!.permissions.includes('customers:merge')) {
        throw forbidden('You do not have permission to merge records.');
      }
      const targetId = body.target_id ?? review.candidate_id;
      // target_id may name either side; source is the other one.
      const sourceId = targetId === review.entity_id ? review.candidate_id : review.entity_id;
      counts = review.entity === 'CUSTOMER' ? mergeCustomers(sourceId, targetId, req) : mergeLeads(sourceId, targetId, user.id);
      const existing = JSON.parse(review.metadata ?? '{}');
      run(
        `UPDATE duplicate_reviews SET status = 'MERGED', decided_by = ?, decided_at = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        [user.id, now, JSON.stringify({ ...existing, source_id: sourceId, target_id: targetId, counts }), now, id],
      );
      audit(req, 'CUSTOMER_MERGED'.replace('CUSTOMER', review.entity), 'duplicate_review', id, {
        source_id: sourceId,
        target_id: targetId,
        counts,
      });
      if (review.entity === 'CUSTOMER') {
        notify({
          userId: user.id,
          type: 'CUSTOMER_MERGED',
          title: 'Duplicate customers merged',
          body: `${counts.leads} lead(s) and related records were moved to the kept customer.`,
          entity: 'customer',
          entityId: targetId,
          link: `/customers?search=`,
        });
      }
    } else if (body.action === 'LINKED') {
      const existing = JSON.parse(review.metadata ?? '{}');
      run(
        `UPDATE duplicate_reviews SET status = 'LINKED', decided_by = ?, decided_at = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        [user.id, now, JSON.stringify({ ...existing, linked_to: review.candidate_id, remark: body.remark ?? null }), now, id],
      );
    } else {
      run(
        'UPDATE duplicate_reviews SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?',
        [body.action, user.id, now, now, id],
      );
    }

    if (body.action !== 'MERGED') {
      audit(req, 'DUPLICATE_DECIDED', 'duplicate_review', id, { action: body.action, entity: review.entity });
    }

    const row = get('SELECT * FROM duplicate_reviews WHERE id = ?', [id]);
    ok(res, { ...shapeReview(row!), counts });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- DISMISS ALL ---------------------------- */

duplicatesRouter.post('/bulk-decide', requireAuth, requirePermission('leads:read_all'), (req, res, next) => {
  try {
    const body = meta(
      z.object({ action: z.enum(['KEPT_SEPARATE', 'IGNORED']), ids: z.array(z.number().int().positive()).max(500) }),
      req.body,
    );
    const user = currentUser(req);
    const now = nowISO();
    let updated = 0;
    for (const id of body.ids) {
      const res2 = run(
        `UPDATE duplicate_reviews SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'OPEN'`,
        [body.action, user.id, now, now, id],
      );
      updated += res2.changes;
    }
    audit(req, 'DUPLICATE_DECIDED', 'duplicate_review', null, { action: body.action, updated });
    ok(res, { updated });
  } catch (err) {
    next(err);
  }
});
