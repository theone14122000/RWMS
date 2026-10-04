import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nowISO, run } from '../db/database.js';

/**
 * Private document storage.
 *
 * Files live outside `client/dist` (so they are never served statically) and
 * are addressed on disk by a random token — there is no predictable public
 * URL. Access always goes through the authenticated, audited file endpoint.
 */

const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/msword': ['.doc'],
  'application/vnd.ms-excel': ['.xls'],
  'application/zip': ['.zip'],
};

export function uploadDir(): string {
  return path.join(path.dirname(config.databasePath), 'uploads');
}

export function sanitizeFilename(name: string): string {
  const base = path
    .basename(String(name || 'file'))
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('');
  return (base || 'file').slice(0, 180);
}

export interface SaveDocumentInput {
  entity: 'CUSTOMER' | 'LEAD' | 'QUOTATION' | 'BOOKING' | 'CALL' | 'GENERAL';
  entityId: number;
  category?: string | null;
  filename: string;
  mimeType: string;
  content: Buffer;
  uploadedBy?: number | null;
}

export function saveDocument(input: SaveDocumentInput): { id: number; stored_name: string } {
  const mime = String(input.mimeType || '').toLowerCase();
  const allowed = ALLOWED_MIME[mime];
  if (!allowed) throw badRequest('This file type is not allowed.');
  if (!input.content.length) throw badRequest('The file is empty.');
  if (input.content.length > MAX_BYTES) throw badRequest('File exceeds the 10 MB limit.');

  const display = sanitizeFilename(input.filename);
  const ext = path.extname(display).toLowerCase() || allowed[0];
  if (ext && !allowed.includes(ext)) throw badRequest('File extension does not match its content type.');

  const stored = `doc_${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.mkdirSync(uploadDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadDir(), stored), input.content, { mode: 0o600 });

  const res = run(
    `INSERT INTO documents (entity, entity_id, category, filename, stored_name, mime_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.entity, input.entityId, input.category ?? null, display, stored, mime, input.content.length, input.uploadedBy ?? null, nowISO()],
  );
  return { id: res.lastInsertRowid, stored_name: stored };
}

export interface DocumentRow {
  id: number;
  entity: string;
  entity_id: number;
  category: string | null;
  filename: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: number | null;
  created_at: string;
  deleted_at: string | null;
}

export function documentPath(doc: DocumentRow): string {
  const dir = uploadDir();
  const full = path.join(dir, path.basename(doc.stored_name));
  if (!full.startsWith(dir)) throw notFound('File not found.');
  return full;
}

export function deleteDocumentFile(doc: DocumentRow): void {
  try {
    const full = documentPath(doc);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    /* best effort */
  }
}

/** Accepts a raw base64 string or a `data:<mime>;base64,` data URL. */
export function parseBase64(dataUrl: string): { buffer: Buffer; mime: string | null } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
  if (match) return { buffer: Buffer.from(match[2], 'base64'), mime: match[1] };
  return { buffer: Buffer.from(String(dataUrl || ''), 'base64'), mime: null };
}

const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/x-m4a',
  'video/mp4',
]);

/**
 * Stores a call-recording file in the private upload directory. Recordings are
 * audio (plus mp4 screen captures), so they get their own allowlist instead of
 * being forced through the document MIME map.
 */
export function saveRecordingFile(filename: string, mimeType: string, content: Buffer): string {
  const mime = String(mimeType || '').toLowerCase();
  if (!ALLOWED_AUDIO_MIME.has(mime)) throw badRequest('This recording format is not supported.');
  if (!content.length) throw badRequest('The recording is empty.');
  if (content.length > 64 * 1024 * 1024) throw badRequest('Recording exceeds the 64 MB limit.');

  const extMap: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/x-m4a': '.m4a',
    'video/mp4': '.mp4',
  };
  const ext = extMap[mime];
  const stored = `rec_${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.mkdirSync(uploadDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadDir(), stored), content, { mode: 0o600 });
  return stored;
}

export function recordingPath(fileKey: string): string {
  const dir = uploadDir();
  const full = path.join(dir, path.basename(fileKey));
  if (!full.startsWith(dir)) throw notFound('Recording not found.');
  return full;
}
