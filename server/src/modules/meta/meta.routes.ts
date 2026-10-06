import { Router } from 'express';
import { z } from 'zod';
import { all, get, nowISO, run } from '../../db/database.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { created, meta, ok } from '../../lib/http.js';
import { can, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { invalidatePermissionCache } from '../../middleware/auth.js';
import { telephonyStatus } from '../../services/telephony.js';
import { channelStatus } from '../../services/communications.js';
import { aiStatus } from '../../services/ai.js';
import {
  assignmentConfig,
  callPolicy,
  reminderConfig,
  retentionConfig,
} from '../../services/settings.js';

export const metaRouter = Router();

const sourceSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

const statusSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_]+$/, 'Code must be uppercase letters, numbers and underscores'),
  name: z.string().trim().min(2).max(60),
  category: z.enum(['OPEN', 'WON', 'LOST', 'NEUTRAL']).default('OPEN'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #2563eb')
    .default('#64748b'),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

const statusPatchSchema = statusSchema.partial().omit({ code: true });

const settingsSchema = z.object({
  value: z.any().refine((v) => JSON.stringify(v).length <= 20000, 'Setting value is too large'),
});

/**
 * Option lists every authenticated user may read (forms, pickers). Everything
 * else in the settings table (assignment, telephony, AI, retention, …) is
 * operational configuration and stays behind settings:manage.
 */
const PUBLIC_SETTING_KEYS = new Set([
  'trip_types',
  'requirements_options',
  'priorities',
  'follow_up_types',
  'currencies',
  'lead_number_prefix',
  'business',
]);

/** GET /api/meta — all configurable option lists used by the UI. */
metaRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const statuses = await all('SELECT * FROM lead_statuses ORDER BY sort_order ASC, id ASC');
    const sources = await all('SELECT * FROM lead_sources ORDER BY sort_order ASC, id ASC');
    const canManageSettings = can(req, 'settings:manage');
    const settings = await all<{ setting_key: string; value: string }>('SELECT setting_key, value FROM settings');
    const options: Record<string, unknown> = {};
    for (const s of settings) {
      if (!canManageSettings && !PUBLIC_SETTING_KEYS.has(s.setting_key)) continue;
      try {
        options[s.setting_key] = JSON.parse(s.value);
      } catch {
        options[s.setting_key] = null;
      }
    }
    const roles = await all('SELECT id, code, name, description FROM roles ORDER BY id ASC');
    const permissions = await all('SELECT id, code, name, category FROM permissions ORDER BY category ASC, code ASC');

    ok(res, {
      statuses,
      sources,
      options,
      roles,
      permissions,
      follow_up_board: [
        { key: 'PENDING', label: 'Pending' },
        { key: 'TODAY', label: 'Today' },
        { key: 'OVERDUE', label: 'Overdue' },
        { key: 'COMPLETED', label: 'Completed' },
        { key: 'CONVERTED', label: 'Converted' },
        { key: 'NOT_INTERESTED', label: 'Not Interested' },
      ],
    });
  } catch (err) {
    next(err);
  }
});

metaRouter.post('/sources', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const body = meta(sourceSchema, req.body);
    const existing = await get('SELECT id FROM lead_sources WHERE lower(name) = lower(?)', [body.name]);
    if (existing) throw badRequest('A lead source with this name already exists.');
    const now = await nowISO();
    const maxOrder = (await get<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) AS n FROM lead_sources'))!.n;
    const id = (await run(
      'INSERT INTO lead_sources (name, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [body.name, body.is_active === false ? 0 : 1, body.sort_order ?? maxOrder + 10, now, now],
    )).lastInsertRowid;
    await audit(req, 'LEAD_SOURCE_CREATED', 'lead_source', id, { name: body.name });
    created(res, await get('SELECT * FROM lead_sources WHERE id = ?', [id]));
  } catch (err) {
    next(err);
  }
});

metaRouter.patch('/sources/:id', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get<any>('SELECT * FROM lead_sources WHERE id = ?', [id]);
    if (!existing) throw notFound('Lead source not found.');
    const body = meta(sourceSchema.partial(), req.body);
    await run('UPDATE lead_sources SET name = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?', [
      body.name ?? existing.name,
      body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0,
      body.sort_order ?? existing.sort_order,
      await nowISO(),
      id,
    ]);
    await audit(req, 'LEAD_SOURCE_UPDATED', 'lead_source', id, { changed: Object.keys(body) });
    ok(res, await get('SELECT * FROM lead_sources WHERE id = ?', [id]));
  } catch (err) {
    next(err);
  }
});

metaRouter.post('/statuses', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const body = meta(statusSchema, req.body);
    const existing = await get('SELECT id FROM lead_statuses WHERE code = ?', [body.code]);
    if (existing) throw badRequest('A status with this code already exists.');
    const now = await nowISO();
    const maxOrder = (await get<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) AS n FROM lead_statuses'))!.n;
    const id = (await run(
      `INSERT INTO lead_statuses (code, name, category, color, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        body.name,
        body.category,
        body.color,
        body.is_active === false ? 0 : 1,
        body.sort_order ?? maxOrder + 10,
        now,
        now,
      ],
    )).lastInsertRowid;
    await audit(req, 'LEAD_STATUS_CREATED', 'lead_status', id, { code: body.code });
    created(res, await get('SELECT * FROM lead_statuses WHERE id = ?', [id]));
  } catch (err) {
    next(err);
  }
});

metaRouter.patch('/statuses/:id', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get<any>('SELECT * FROM lead_statuses WHERE id = ?', [id]);
    if (!existing) throw notFound('Lead status not found.');
    const body = meta(statusPatchSchema, req.body);
    await run(
      'UPDATE lead_statuses SET name = ?, category = ?, color = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      [
        body.name ?? existing.name,
        body.category ?? existing.category,
        body.color ?? existing.color,
        body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0,
        body.sort_order ?? existing.sort_order,
        await nowISO(),
        id,
      ],
    );
    await audit(req, 'LEAD_STATUS_UPDATED', 'lead_status', id, { changed: Object.keys(body) });
    ok(res, await get('SELECT * FROM lead_statuses WHERE id = ?', [id]));
  } catch (err) {
    next(err);
  }
});

metaRouter.get('/settings', requireAuth, requirePermission('settings:manage'), async (_req, res, next) => {
  try {
    const rows = await all<{ setting_key: string; value: string; updated_at: string }>(
      'SELECT setting_key, value, updated_at FROM settings ORDER BY setting_key ASC',
    );
    ok(
      res,
      rows.map((r) => ({
        key: r.setting_key,
        value: safeParse(r.value),
        updated_at: r.updated_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

metaRouter.patch('/settings/:key', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const existing = await get('SELECT setting_key FROM settings WHERE setting_key = ?', [key]);
    if (!existing) throw notFound('Setting not found.');
    const body = meta(settingsSchema, req.body);
    await run('UPDATE settings SET value = ?, updated_at = ? WHERE setting_key = ?', [
      JSON.stringify(body.value),
      await nowISO(),
      key,
    ]);
    await audit(req, 'SETTING_UPDATED', 'setting', key, {});
    ok(res, { key, value: body.value });
  } catch (err) {
    next(err);
  }
});

/** POST /api/meta/permissions/cache/reset — refresh RBAC cache after role edits (Part 2 hook). */
metaRouter.post('/permissions/cache/reset', requireAuth, requirePermission('settings:manage'), async (req, res, next) => {
  try {
    invalidatePermissionCache();
    await audit(req, 'PERMISSION_CACHE_RESET', 'system', null, {});
    ok(res, { reset: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/meta/integrations — honest integration status. Secrets are never
 * returned: only whether the referenced environment variable is present.
 */
metaRouter.get('/integrations', requireAuth, requirePermission('settings:manage'), async (_req, res, next) => {
  try {
    ok(res, {
      telephony: await telephonyStatus(),
      channels: {
        whatsapp: await channelStatus('WHATSAPP'),
        email: await channelStatus('EMAIL'),
        sms: await channelStatus('SMS'),
        in_app: { configured: true, provider: 'internal', base_url: '', secret_present: true },
      },
      ai: await aiStatus(),
      assignment: await assignmentConfig(),
      call_policy: await callPolicy(),
      reminders: await reminderConfig(),
      retention: await retentionConfig(),
    });
  } catch (err) {
    next(err);
  }
});

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
