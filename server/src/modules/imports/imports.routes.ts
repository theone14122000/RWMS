import { Router } from 'express';
import { z } from 'zod';
import { all, get, likeTerm, nowISO, run, tx } from '../../db/database.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination } from '../../lib/http.js';
import { currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import { parseBase64 } from '../../services/documents.js';
import { parseCsv, guessColumn } from '../../services/csv.js';
import { nextLeadNumber } from '../leads/leads.service.js';
import { autoAssignLead } from '../../services/assigner.js';
import { assignmentConfig } from '../../services/settings.js';
import type { LeadRow } from '../leads/leads.service.js';

export const importsRouter = Router();

/** Canonical CSV columns the importer understands. */
const CANONICAL = [
  'name',
  'phone',
  'email',
  'city',
  'destination',
  'source',
  'budget',
  'priority',
  'trip_type',
  'travel_start',
  'travel_end',
  'notes',
] as const;
type Canonical = (typeof CANONICAL)[number];

const PRIORITY_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function normalizePhone(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '').slice(0, 15);
}

interface ParsedRow {
  row: number;
  status: 'VALID' | 'DUPLICATE' | 'INVALID';
  error?: string;
  values: Partial<Record<Canonical, string>>;
}

function jobShape(row: Record<string, any>): Record<string, any> {
  let preview: unknown = [];
  let errors: unknown = [];
  let columnMap: unknown = {};
  try {
    preview = JSON.parse(row.preview ?? '[]');
  } catch {
    preview = [];
  }
  try {
    errors = JSON.parse(row.errors ?? '[]');
  } catch {
    errors = [];
  }
  try {
    columnMap = JSON.parse(row.column_map ?? '{}');
  } catch {
    columnMap = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    status: row.status,
    column_map: columnMap,
    preview: Array.isArray(preview) ? preview.slice(0, 20) : [],
    total_rows: row.total_rows,
    valid_rows: row.valid_rows,
    invalid_rows: row.invalid_rows,
    duplicate_rows: row.duplicate_rows,
    imported_rows: row.imported_rows,
    failed_rows: row.failed_rows,
    errors,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
  };
}

/* ------------------------------ PARSE/UPLOAD -------------------------- */

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(180),
  content_base64: z.string().min(1).max(4_000_000),
});

importsRouter.post('/', requireAuth, requirePermission('imports:manage'), (req, res, next) => {
  try {
    const body = meta(uploadSchema, req.body);
    const user = currentUser(req);
    const { buffer } = parseBase64(body.content_base64);
    const text = buffer.toString('utf8');
    const rows = parseCsv(text);
    if (rows.length < 2) throw badRequest('The file needs a header row and at least one data row.');

    const headers = rows[0].map((h) => h.trim());
    const columnMap: Partial<Record<Canonical, number>> = {};
    for (const canonical of CANONICAL) {
      const idx = headers.findIndex((h) => guessColumn(h, [canonical]) !== null);
      if (idx >= 0) columnMap[canonical] = idx;
    }
    if (columnMap.name === undefined) throw badRequest('No "name" column was found in the header row.');
    if (columnMap.phone === undefined) throw badRequest('No "phone" column was found in the header row.');

    const existingPhones = new Set(
      all<{ phone: string }>('SELECT phone FROM customers WHERE deleted_at IS NULL AND phone IS NOT NULL').map(
        (r) => normalizePhone(r.phone),
      ),
    );

    const parsed: ParsedRow[] = [];
    const errors: Array<{ row: number; message: string }> = [];
    const seenPhones = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      const values: Partial<Record<Canonical, string>> = {};
      for (const canonical of CANONICAL) {
        const idx = columnMap[canonical];
        if (idx !== undefined && cells[idx] !== undefined) values[canonical] = String(cells[idx]).trim();
      }

      const rowNo = i + 1;
      const name = values.name ?? '';
      const phone = normalizePhone(values.phone ?? '');
      if (!name) {
        parsed.push({ row: rowNo, status: 'INVALID', error: 'Customer name is required.', values });
        if (errors.length < 50) errors.push({ row: rowNo, message: 'Customer name is required.' });
        continue;
      }
      if (phone.length < 7) {
        parsed.push({ row: rowNo, status: 'INVALID', error: 'Phone number looks too short.', values });
        if (errors.length < 50) errors.push({ row: rowNo, message: 'Phone number looks too short.' });
        continue;
      }

      if (existingPhones.has(phone)) {
        parsed.push({ row: rowNo, status: 'DUPLICATE', error: 'A customer with this phone already exists.', values });
        continue;
      }
      if (seenPhones.has(phone)) {
        parsed.push({ row: rowNo, status: 'DUPLICATE', error: 'Duplicate phone within this file.', values });
        continue;
      }
      seenPhones.add(phone);
      parsed.push({ row: rowNo, status: 'VALID', values });
    }

    const total = parsed.length;
    const valid = parsed.filter((r) => r.status === 'VALID').length;
    const invalid = parsed.filter((r) => r.status === 'INVALID').length;
    const duplicates = parsed.filter((r) => r.status === 'DUPLICATE').length;

    const now = nowISO();
    const jobId = run(
      `INSERT INTO import_jobs (kind, filename, status, column_map, preview, total_rows, valid_rows, invalid_rows,
        duplicate_rows, imported_rows, failed_rows, errors, created_by, created_at, updated_at)
       VALUES ('LEADS', ?, 'PARSED', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      [
        body.filename,
        JSON.stringify(columnMap),
        JSON.stringify(parsed),
        total,
        valid,
        invalid,
        duplicates,
        JSON.stringify(errors),
        user.id,
        now,
        now,
      ],
    ).lastInsertRowid;

    audit(req, 'IMPORT_PARSED', 'import_job', jobId, {
      filename: body.filename,
      total,
      valid,
      invalid,
      duplicates,
    });

    const row = get('SELECT * FROM import_jobs WHERE id = ?', [jobId]);
    created(res, jobShape(row!));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- LIST -------------------------------- */

importsRouter.get('/', requireAuth, requirePermission('imports:manage'), (req, res, next) => {
  try {
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
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
      where.push('filename LIKE ? ESCAPE \'\\\'');
      params.push(likeTerm(search));
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM import_jobs ${whereSql}`, params)!.c;
    const rows = all(`SELECT * FROM import_jobs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    list(res, rows.map(jobShape), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DETAIL ------------------------------ */

importsRouter.get('/:id(\\d+)', requireAuth, requirePermission('imports:manage'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = get('SELECT * FROM import_jobs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Import job not found.');
    ok(res, jobShape(row));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- RUN --------------------------------- */

const runSchema = z.object({
  import_duplicates: z.boolean().default(false),
  assign: z.enum(['AUTO', 'MANUAL', 'NONE']).default('AUTO'),
  worker_id: z.number().int().positive().optional(),
});

function resolveSourceId(name: string | undefined): number | null {
  if (!name) return null;
  const existing = get<{ id: number }>('SELECT id FROM lead_sources WHERE name = ? COLLATE NOCASE', [name]);
  if (existing) return existing.id;
  const now = nowISO();
  return run('INSERT INTO lead_sources (name, sort_order, created_at, updated_at) VALUES (?, 999, ?, ?)', [
    name,
    now,
    now,
  ]).lastInsertRowid;
}

function defaultStatusId(): number {
  const preferred = get<{ id: number }>(`SELECT id FROM lead_statuses WHERE code = 'NEW' AND is_active = 1`);
  if (preferred) return preferred.id;
  const first = get<{ id: number }>('SELECT id FROM lead_statuses WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1');
  if (!first) throw badRequest('No active lead status is configured.');
  return first.id;
}

importsRouter.post('/:id(\\d+)/run', requireAuth, requirePermission('imports:manage'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const job = get<any>('SELECT * FROM import_jobs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!job) throw notFound('Import job not found.');
    if (job.status === 'COMPLETED') throw conflict('This import has already been run.');
    if (job.status !== 'PARSED') throw conflict(`An import in status ${job.status} cannot be run.`);

    const body = meta(runSchema, req.body);
    const user = currentUser(req);
    if (body.assign === 'MANUAL') {
      if (!body.worker_id) throw badRequest('worker_id is required when assign is MANUAL.');
      const worker = get<{ status: string }>('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL', [
        body.worker_id,
      ]);
      if (!worker) throw badRequest('Selected worker does not exist.');
      if (worker.status !== 'ACTIVE') throw badRequest('Selected worker is not active.');
    }

    const rows: ParsedRow[] = JSON.parse(job.preview ?? '[]');
    const now = nowISO();
    run('UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?', ['IMPORTING', now, id]);

    const cfg = assignmentConfig();
    let imported = 0;
    let failed = 0;
    const runErrors: Array<{ row: number; message: string }> = JSON.parse(job.errors ?? '[]');
    const phoneIndex = new Map<string, number>();
    for (const r of all<{ id: number; phone: string | null }>(
      'SELECT id, phone FROM customers WHERE deleted_at IS NULL',
    )) {
      const key = normalizePhone(r.phone ?? '');
      if (key.length >= 7 && !phoneIndex.has(key)) phoneIndex.set(key, r.id);
    }

    for (const parsedRow of rows) {
      if (parsedRow.status === 'INVALID') {
        failed += 1;
        continue;
      }
      if (parsedRow.status === 'DUPLICATE' && !body.import_duplicates) continue;

      const values = parsedRow.values;
      const phoneDigits = normalizePhone(values.phone ?? '');
      try {
        tx(() => {
          let customerId: number;
          const existingCustomerId = phoneIndex.get(phoneDigits);
          if (existingCustomerId) {
            customerId = existingCustomerId;
          } else {
            customerId = run(
              `INSERT INTO customers (name, phone, whatsapp, email, city, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                values.name,
                values.phone ?? null,
                values.phone ?? null,
                values.email || null,
                values.city || null,
                user.id,
                now,
                now,
              ],
            ).lastInsertRowid;
            phoneIndex.set(phoneDigits, customerId);
            audit(req, 'CUSTOMER_CREATED', 'customer', customerId, { via: 'import', job_id: id });
          }

          const priority = PRIORITY_VALUES.includes(String(values.priority).toUpperCase())
            ? String(values.priority).toUpperCase()
            : 'MEDIUM';
          const travelType = ['DOMESTIC', 'INTERNATIONAL'].includes(String(values.trip_type).toUpperCase())
            ? String(values.trip_type).toUpperCase()
            : null;

          const leadId = run(
            `INSERT INTO leads (lead_number, customer_id, source_id, assigned_to, destination, travel_type, trip_type,
              requirements, travel_start_date, travel_end_date, budget, priority, status_id, notes, custom_fields,
              import_job_id, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
            [
              nextLeadNumber(),
              customerId,
              resolveSourceId(values.source),
              values.destination || null,
              travelType,
              null,
              values.travel_start || null,
              values.travel_end || null,
              values.budget ? Number(String(values.budget).replace(/[^\d.]/g, '')) || null : null,
              priority,
              defaultStatusId(),
              values.notes || null,
              id,
              user.id,
              user.id,
              now,
              now,
            ],
          ).lastInsertRowid;

          addTimelineEvent({
            leadId,
            type: TIMELINE_TYPES.LEAD_IMPORTED,
            actorId: user.id,
            summary: `Lead imported from ${job.filename}`,
            metadata: { import_job_id: id, row: parsedRow.row },
          });

          if (body.assign === 'MANUAL' && body.worker_id) {
            const lead = get<LeadRow>('SELECT * FROM leads WHERE id = ?', [leadId])!;
            autoAssignLead({ lead, actorId: user.id, actorName: user.name, strategy: 'MANUAL' });
            run('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?', [body.worker_id, now, leadId]);
            run(
              `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, action, reason, assigned_at)
               VALUES (?, ?, ?, 'ASSIGNED', 'import:manual', ?)`,
              [leadId, body.worker_id, user.id, now],
            );
          } else if (body.assign === 'AUTO' && cfg.auto_assign_new) {
            const lead = get<LeadRow>('SELECT * FROM leads WHERE id = ?', [leadId])!;
            autoAssignLead({ lead, actorId: user.id, actorName: user.name });
          }

          imported += 1;
        });
      } catch (err) {
        failed += 1;
        if (runErrors.length < 50) {
          runErrors.push({
            row: parsedRow.row,
            message: err instanceof Error ? err.message : 'Row import failed.',
          });
        }
      }
    }

    run(
      `UPDATE import_jobs SET status = 'COMPLETED', imported_rows = ?, failed_rows = ?, errors = ?, updated_at = ?,
         completed_at = ? WHERE id = ?`,
      [imported, failed, JSON.stringify(runErrors), nowISO(), nowISO(), id],
    );

    audit(req, 'IMPORT_COMPLETED', 'import_job', id, { imported, failed, filename: job.filename });

    const row = get('SELECT * FROM import_jobs WHERE id = ?', [id]);
    ok(res, { ...jobShape(row!), imported_rows: imported, failed_rows: failed, error_count: runErrors.length });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DELETE ------------------------------ */

importsRouter.delete('/:id(\\d+)', requireAuth, requirePermission('imports:manage'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const job = get<{ id: number }>('SELECT id FROM import_jobs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!job) throw notFound('Import job not found.');
    run('UPDATE import_jobs SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowISO(), nowISO(), id]);
    audit(req, 'IMPORT_DELETED', 'import_job', id, {});
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
