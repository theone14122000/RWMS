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
async function assertEntityAccess(entity: string, entityId: number, req: any, opts?: { forWrite?: boolean }): Promise<void> {
  const user = req.user!;
  if (entity === 'GENERAL') {
    // General files have no parent record: writes go to your own uploads,
    // reads are limited to managers.
    if (opts?.forWrite) return;
    if (!user.permissions.includes('documents:manage')) {
      throw forbidden('General documents are restricted to administrators.');
    }
    return;
  }

  if (entity === 'LEAD') {
    const lead = await get<{ assigned_to: number | null }>(
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
    const customer = await get<{ id: number }>('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [entityId]);
    if (!customer) throw notFound('Customer not found.');
    if (!user.permissions.includes('leads:read_all')) {
      const owned = await get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL',
        [entityId, user.id],
      );
      if (!owned?.c) throw forbidden('You do not have access to this customer.');
    }
    return;
  }

  if (entity === 'QUOTATION' || entity === 'BOOKING') {
    const table = entity === 'QUOTATION' ? 'quotations' : 'bookings';
    const row = await get<{ worker_id: number | null; created_by: number | null }>(
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
    const call = await get<{ worker_id: number }>('SELECT worker_id FROM calls WHERE id = ? AND deleted_at IS NULL', [
      entityId,
    ]);
    if (!call) throw notFound('Call not found.');
    if (!user.permissions.includes('calls:read_all') && call.worker_id !== user.id) {
      throw forbidden('You do not have access to this call.');
    }
  }
}

/* -------------------------------- LIST -------------------------------- */

documentsRouter.get('/', requireAuth, requirePermission('documents:read'), async (req, res, next) => {
  try {
    const entity = String(req.query.entity ?? '').trim().toUpperCase();
    const entityId = Number(req.query.entity_id);
    const isManager = can(req, 'documents:manage');
    const where: string[] = ['d.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (!isManager) {
      // Scoped listing only: a caller must name the parent record they can access.
      if (!entity || !entityId) throw badRequest('entity and entity_id are required.');
    }
    if (entity) {
      if (!ENTITIES.includes(entity as any)) throw badRequest('Unknown entity.');
      where.push('d.entity = ?');
      params.push(entity);
      if (entityId) {
        where.push('d.entity_id = ?');
        params.push(entityId);
        await assertEntityAccess(entity, entityId, req);
      }
    } else if (isManager) {
      await audit(req, 'DOCUMENT_LISTED', 'document', null, { scope: 'all' });
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
    const total = (await get<{ c: number }>(`SELECT COUNT(*) AS c FROM documents d ${whereSql}`, params))!.c;
    const rows = await all(
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

documentsRouter.post('/', requireAuth, requirePermission('documents:upload'), async (req, res, next) => {
  try {
    const body = meta(uploadSchema, req.body);
    await assertEntityAccess(body.entity, body.entity_id, req, { forWrite: true });
    const user = currentUser(req);
    const parsed = parseBase64(body.content_base64);

    const saved = await saveDocument({
      entity: body.entity,
      entityId: body.entity_id,
      category: body.category ?? null,
      filename: body.filename,
      mimeType: body.mime_type || parsed.mime || 'application/octet-stream',
      content: parsed.buffer,
      uploadedBy: user.id,
    });

    await afterUpload(body.entity, body.entity_id, saved.id, user.id, req);
    const row = await get(
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
      await assertEntityAccess(entity, entityId, req, { forWrite: true });

      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!content.length) throw badRequest('No file bytes were received.');
      const user = currentUser(req);
      const filename = String(req.header('x-filename') || 'file.bin').slice(0, 180);
      const mime = String(req.header('x-mime-type') || 'application/octet-stream').slice(0, 120);
      const category = String(req.header('x-category') || '').slice(0, 60) || null;

      const saved = await saveDocument({
        entity: entity as (typeof ENTITIES)[number],
        entityId,
        category,
        filename,
        mimeType: mime,
        content,
        uploadedBy: user.id,
      });

      await afterUpload(entity, entityId, saved.id, user.id, req);
      const row = await get(
        `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
        [saved.id],
      );
      created(res, shapeDocument(row!));
    } catch (err) {
      next(err);
    }
  },
);

async function afterUpload(entity: string, entityId: number, docId: number, actorId: number, req: any): Promise<void> {
  await audit(req, 'DOCUMENT_UPLOADED', 'document', docId, { entity, entity_id: entityId });
  if (entity === 'LEAD') {
    await addTimelineEvent({
      leadId: entityId,
      type: TIMELINE_TYPES.DOCUMENT_UPLOADED,
      actorId,
      summary: 'Document uploaded',
      metadata: { document_id: docId },
    });
  }
}

/* -------------------------------- DETAIL ------------------------------ */

documentsRouter.get('/:id(\\d+)', requireAuth, requirePermission('documents:read'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get<any>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Document not found.');
    if (row.entity === 'GENERAL') {
      const user = currentUser(req);
      if (!user.permissions.includes('documents:manage') && row.uploaded_by !== user.id) {
        throw forbidden('You do not have access to this document.');
      }
    } else {
      await assertEntityAccess(row.entity, row.entity_id, req);
    }
    const full = await get(
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
      const row = await get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!row) throw notFound('Document not found.');
      if (row.entity === 'GENERAL') {
        const user = currentUser(req);
        if (!user.permissions.includes('documents:manage') && row.uploaded_by !== user.id) {
          throw forbidden('You do not have access to this document.');
        }
      } else {
        await assertEntityAccess(row.entity, row.entity_id, req);
      }

      const { documentPath } = await import('../../services/documents.js');
      const fs = await import('node:fs');
      const file = documentPath(row);
      if (!fs.existsSync(file)) throw notFound('The file is missing from storage.');

      await audit(req, 'DOCUMENT_ACCESSED', 'document', row.id, { entity: row.entity, entity_id: row.entity_id });
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

documentsRouter.delete('/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!row) throw notFound('Document not found.');
    const user = currentUser(req);
    const isUploader = row.uploaded_by === user.id;
    const isManager = user.permissions.includes('documents:manage');
    if (!isManager && !isUploader) {
      throw forbidden('Only the uploader or an admin can delete this document.');
    }
    // A non-manager uploader must still have access to the parent record.
    if (!isManager) {
      if (row.entity === 'GENERAL') {
        /* uploader restriction already enforced above */
      } else {
        await assertEntityAccess(row.entity, row.entity_id, req);
      }
    }

    const now = await nowISO();
    await run('UPDATE documents SET deleted_at = ? WHERE id = ?', [now, id]);
    deleteDocumentFile(row);
    await audit(req, 'DOCUMENT_DELETED', 'document', id, { entity: row.entity, entity_id: row.entity_id });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
