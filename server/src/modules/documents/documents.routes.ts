import { Router, raw } from 'express';
import { z } from 'zod';
import { all, get, nowISO, run } from '../../db/database.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { buildMeta, created, list, meta, ok, pagination, toArray } from '../../lib/http.js';
import { can, currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { addTimelineEvent, TIMELINE_TYPES } from '../../services/timeline.js';
import {
  deleteDocumentFile,
  parseBase64,
  saveDocument,
  type DocumentRow,
} from '../../services/documents.js';

export const documentsRouter = Router();

const ENTITIES = ['CUSTOMER', 'LEAD', 'QUOTATION', 'BOOKING', 'CALL', 'GENERAL'] as const;

function shapeDocument(row: Record<string, any>): Record<string, any> {
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entity_id,
    category: row.category ?? null,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: row.uploaded_by ?? null,
    uploaded_by_name: row.uploaded_by_name ?? null,
    created_at: row.created_at,
  };
}

/** Access mirrors the parent record's access rules. */
function assertEntityAccess(entity: string, entityId: number, req: any): void {
  const user = req.user!;
  if (entity === 'GENERAL') return;

  if (entity === 'LEAD') {
    const lead = get<{ assigned_to: number | null }>(
      'SELECT assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL',
      [entityId],
    );
    if (!lead) throw notFound('Lead not found.');
    if (!user.permissions.includes('leads:read_all') && lead.assigned_to !== user.id) {
      throw forbidden('You do not have access to this lead.');
    }
    return;
  }

  if (entity === 'CUSTOMER') {
    const customer = get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [entityId]);
    if (!customer) throw notFound('Customer not found.');
    if (!user.permissions.includes('leads:read_all')) {
      const owned = get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL',
        [entityId, user.id],
      );
      if (!owned?.c) throw forbidden('You do not have access to this customer.');
    }
    return;
  }

  if (entity === 'QUOTATION' || entity === 'BOOKING') {
    const table = entity === 'QUOTATION' ? 'quotations' : 'bookings';
    const row = get<{ worker_id: number | null; created_by: number | null }>(
      `SELECT worker_id, created_by FROM ${table} WHERE id = ? AND deleted_at IS NULL`,
      [entityId],
    );
    if (!row) throw notFound(entity === 'QUOTATION' ? 'Quotation not found.' : 'Booking not found.');
    const readAll = user.permissions.includes(entity === 'QUOTATION' ? 'quotations:read_all' : 'bookings:read_all');
    if (!readAll && row.worker_id !== user.id && row.created_by !== user.id) {
      throw forbidden('You do not have access to this record.');
    }
    return;
  }

  if (entity === 'CALL') {
    const call = get<{ worker_id: number }>('SELECT worker_id FROM calls WHERE id = ? AND deleted_at IS NULL', [
      entityId,
    ]);
    if (!call) throw notFound('Call not found.');
    if (!user.permissions.includes('calls:read_all') && call.worker_id !== user.id) {
      throw forbidden('You do not have access to this call.');
    }
  }
}

/* -------------------------------- LIST -------------------------------- */

documentsRouter.get('/', requireAuth, requirePermission('documents:read'), (req, res, next) => {
  try {
    const entity = String(req.query.entity ?? '').trim().toUpperCase();
    const entityId = Number(req.query.entity_id);
    const where: string[] = ['d.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (entity) {
      if (!ENTITIES.includes(entity as any)) throw badRequest('Unknown entity.');
      where.push('d.entity = ?');
      params.push(entity);
      if (entityId) {
        where.push('d.entity_id = ?');
        params.push(entityId);
        assertEntityAccess(entity, entityId, req);
      }
    }

    const categories = toArray(req.query.category);
    if (categories.length) {
      where.push(`d.category IN (${categories.map(() => '?').join(',')})`);
      params.push(...categories);
    }
    const search = String(req.query.search ?? '').trim();
    if (search) {
      where.push(`d.filename LIKE ? ESCAPE '\\'`);
      params.push(`%${search.replace(/[%_\\]/g, '\\$&')}%`);
    }

    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get<{ c: number }>(`SELECT COUNT(*) AS c FROM documents d ${whereSql}`, params)!.c;
    const rows = all(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by ${whereSql}
       ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    list(res, rows.map(shapeDocument), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- UPLOAD ------------------------------ */

const uploadSchema = z.object({
  entity: z.enum(ENTITIES),
  entity_id: z.number().int().positive(),
  category: z.string().trim().max(60).optional().nullable(),
  filename: z.string().trim().min(1).max(180),
  mime_type: z.string().trim().max(120).default('application/octet-stream'),
  content_base64: z.string().min(1).max(14_000_000),
});

documentsRouter.post('/', requireAuth, requirePermission('documents:upload'), (req, res, next) => {
  try {
    const body = meta(uploadSchema, req.body);
    assertEntityAccess(body.entity, body.entity_id, req);
    const user = currentUser(req);
    const parsed = parseBase64(body.content_base64);

    const saved = saveDocument({
      entity: body.entity,
      entityId: body.entity_id,
      category: body.category ?? null,
      filename: body.filename,
      mimeType: body.mime_type || parsed.mime || 'application/octet-stream',
      content: parsed.buffer,
      uploadedBy: user.id,
    });

    afterUpload(body.entity, body.entity_id, saved.id, user.id, req);
    const row = get(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
      [saved.id],
    );
    created(res, shapeDocument(row!));
  } catch (err) {
    next(err);
  }
});

/**
 * Raw upload for larger files: the app-wide JSON parser is capped at 1 MB, so
 * binaries are posted as bytes with metadata in headers.
 */
documentsRouter.post(
  '/file',
  requireAuth,
  requirePermission('documents:upload'),
  raw({ limit: '10mb' }),
  async (req, res, next) => {
    try {
      const entity = String(req.header('x-entity') ?? '').toUpperCase();
      if (!ENTITIES.includes(entity as any)) throw badRequest('A valid X-Entity header is required.');
      const entityId = Number(req.header('x-entity-id'));
      if (!entityId) throw badRequest('An X-Entity-Id header is required.');
      assertEntityAccess(entity, entityId, req);

      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!content.length) throw badRequest('No file bytes were received.');
      const user = currentUser(req);
      const filename = String(req.header('x-filename') || 'file.bin').slice(0, 180);
      const mime = String(req.header('x-mime-type') || 'application/octet-stream').slice(0, 120);
      const category = String(req.header('x-category') || '').slice(0, 60) || null;

      const saved = saveDocument({
        entity: entity as (typeof ENTITIES)[number],
        entityId,
        category,
        filename,
        mimeType: mime,
        content,
        uploadedBy: user.id,
      });

      afterUpload(entity, entityId, saved.id, user.id, req);
      const row = get(
        `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
        [saved.id],
      );
      created(res, shapeDocument(row!));
    } catch (err) {
      next(err);
    }
  },
);

function afterUpload(entity: string, entityId: number, docId: number, actorId: number, req: any): void {
  audit(req, 'DOCUMENT_UPLOADED', 'document', docId, { entity, entity_id: entityId });
  if (entity === 'LEAD') {
    addTimelineEvent({
      leadId: entityId,
      type: TIMELINE_TYPES.DOCUMENT_UPLOADED,
      actorId,
      summary: 'Document uploaded',
      metadata: { document_id: docId },
    });
  }
}

/* -------------------------------- DETAIL ------------------------------ */

documentsRouter.get('/:id(\\d+)', requireAuth, requirePermission('documents:read'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = get<any>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Document not found.');
    assertEntityAccess(row.entity, row.entity_id, req);
    const full = get(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
      [id],
    );
    ok(res, shapeDocument(full!));
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- FILE ------------------------------- */

documentsRouter.get('/:id(\\d+)/file', requireAuth, requirePermission('documents:read'), (req, res, next) => {
  void (async () => {
    try {
      const id = Number(req.params.id);
      const row = get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!row) throw notFound('Document not found.');
      assertEntityAccess(row.entity, row.entity_id, req);

      const { documentPath } = await import('../../services/documents.js');
      const fs = await import('node:fs');
      const file = documentPath(row);
      if (!fs.existsSync(file)) throw notFound('The file is missing from storage.');

      audit(req, 'DOCUMENT_ACCESSED', 'document', row.id, { entity: row.entity, entity_id: row.entity_id });
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Length', String(fs.statSync(file).size));
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      next(err);
    }
  })();
});

/* -------------------------------- DELETE ------------------------------ */

documentsRouter.delete('/:id(\\d+)', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Document not found.');
    const user = currentUser(req);
    const isUploader = row.uploaded_by === user.id;
    if (!user.permissions.includes('documents:manage') && !isUploader) {
      throw forbidden('Only the uploader or an admin can delete this document.');
    }

    const now = nowISO();
    run('UPDATE documents SET deleted_at = ? WHERE id = ?', [now, id]);
    deleteDocumentFile(row);
    audit(req, 'DOCUMENT_DELETED', 'document', id, { entity: row.entity, entity_id: row.entity_id });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
