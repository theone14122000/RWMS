import { all, get, nowISO, run, tx } from './database.js';
import { config } from '../config.js';
import { hashPassword, randomToken } from '../lib/password.js';
import { ALL_PERMISSION_CODES, PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '../lib/permissions.js';

export const LEAD_STATUSES = [
  { code: 'NEW', name: 'New', category: 'OPEN', color: '#0284c7', sort: 10 },
  { code: 'ASSIGNED', name: 'Assigned', category: 'OPEN', color: '#2563eb', sort: 20 },
  { code: 'CONTACTED', name: 'Contacted', category: 'OPEN', color: '#7c3aed', sort: 30 },
  { code: 'INTERESTED', name: 'Interested', category: 'OPEN', color: '#0891b2', sort: 40 },
  { code: 'FOLLOW_UP', name: 'Follow-up', category: 'OPEN', color: '#d97706', sort: 50 },
  { code: 'QUOTATION_SENT', name: 'Quotation Sent', category: 'OPEN', color: '#ea580c', sort: 60 },
  { code: 'NEGOTIATION', name: 'Negotiation', category: 'OPEN', color: '#c026d3', sort: 70 },
  { code: 'CONVERTED', name: 'Converted', category: 'WON', color: '#16a34a', sort: 80 },
  { code: 'NOT_INTERESTED', name: 'Not Interested', category: 'LOST', color: '#dc2626', sort: 90 },
  { code: 'NO_RESPONSE', name: 'No Response', category: 'LOST', color: '#9f1239', sort: 100 },
  { code: 'INVALID', name: 'Invalid', category: 'LOST', color: '#6b7280', sort: 110 },
  { code: 'CLOSED', name: 'Closed', category: 'LOST', color: '#475569', sort: 120 },
];

export const LEAD_SOURCES = [
  'Website',
  'WhatsApp',
  'Facebook',
  'Instagram',
  'Google Ads',
  'Google Business',
  'Referral',
  'Phone',
  'Walk-in',
  'Partner',
  'Existing Customer',
  'Manual Entry',
  'Imported Lead',
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  trip_types: ['Family', 'Couple', 'Honeymoon', 'Group', 'Corporate', 'Adventure', 'Trekking', 'Pilgrimage', 'Luxury', 'Budget', 'Custom'],
  requirements_options: ['Hotel', 'Cab', 'Flight', 'Train', 'Bus', 'Sightseeing', 'Activities', 'Trek', 'Guide', 'Transfers', 'Complete Package', 'Custom Itinerary'],
  priorities: [
    { value: 'LOW', label: 'Low', color: '#64748b' },
    { value: 'MEDIUM', label: 'Medium', color: '#2563eb' },
    { value: 'HIGH', label: 'High', color: '#d97706' },
    { value: 'URGENT', label: 'Urgent', color: '#dc2626' },
  ],
  follow_up_types: ['Call', 'WhatsApp', 'Email', 'Meeting', 'Site Visit', 'Other'],
  currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'THB', 'SGD'],
  lead_number_prefix: 'LD',
  business: { name: 'Travel Agency CRM', timezone: config.businessTimezone },
  // ---- Part 2 configuration (all editable from Settings, nothing hardcoded) ----
  assignment: {
    strategy: 'MANUAL', // MANUAL | ROUND_ROBIN | WORKLOAD | DESTINATION | SKILL
    auto_assign_new: false,
    destination_rules: [] as Array<{ destination: string; worker_ids: number[] }>,
  },
  call_policy: {
    recording_mode: 'PROVIDER_DEFAULT', // PROVIDER_DEFAULT | RECORD | DO_NOT_RECORD
    consent_notice: 'This call may be recorded for quality and training purposes.',
    retention_days: 180,
  },
  reminders: { enabled: true, overdue_enabled: true },
  telephony: {
    provider: 'none', // none | generic_rest
    base_url: '',
    auth_env: 'TELEPHONY_API_KEY',
    initiate_path: '/calls',
    recording_path: '/calls/{id}/recording',
  },
  communication_providers: {
    whatsapp: { provider: 'none', base_url: '', auth_env: 'WHATSAPP_API_KEY' },
    email: { provider: 'none', base_url: '', auth_env: 'EMAIL_API_KEY' },
    sms: { provider: 'none', base_url: '', auth_env: 'SMS_API_KEY' },
  },
  ai: { provider: 'none', base_url: '', model: '', auth_env: 'AI_API_KEY', enabled: false },
  retention: { call_recordings_days: 180, communications_days: 0, documents_days: 0, audit_logs_days: 0 },
};


async function seedRbac(): Promise<void> {
  const now = nowISO();
  for (const role of ROLES) {
    const existing = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', [role.code]);
    if (existing) {
      await run('UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
        role.name,
        role.description,
        now,
        existing.id,
      ]);
    } else {
      await run('INSERT INTO roles (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        role.code,
        role.name,
        role.description,
        now,
        now,
      ]);
    }
  }

  for (const perm of PERMISSIONS) {
    await run(
      `INSERT INTO permissions (code, name, category, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, category = excluded.category`,
      [perm.code, perm.name, perm.category, now],
    );
  }

  for (const role of ROLES) {
    const roleRow = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', [role.code]);
    if (!roleRow) continue;
    const codes = ROLE_PERMISSIONS[role.code] ?? [];
    const rows = await all<{ id: number; code: string }>('SELECT id, code FROM permissions');
    const allowed = new Set(codes);
    await run('DELETE FROM role_permissions WHERE role_id = ?', [roleRow.id]);
    for (const row of rows) {
      if (!allowed.has(row.code)) continue;
      await run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [
        roleRow.id,
        row.id,
      ]);
    }
  }
}

async function seedStatuses(): Promise<void> {
  const now = nowISO();
  for (const s of LEAD_STATUSES) {
    const existing = await get<{ id: number }>('SELECT id FROM lead_statuses WHERE code = ?', [s.code]);
    if (existing) {
      await run('UPDATE lead_statuses SET name = ?, category = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?', [
        s.name,
        s.category,
        s.color,
        s.sort,
        now,
        existing.id,
      ]);
    } else {
      await run(
        'INSERT INTO lead_statuses (code, name, category, color, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        [s.code, s.name, s.category, s.color, s.sort, now, now],
      );
    }
  }
}

async function seedSources(): Promise<void> {
  const now = nowISO();
  for (const [index, name] of LEAD_SOURCES.entries()) {
    await run(
      `INSERT INTO lead_sources (name, is_active, sort_order, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      [name, (index + 1) * 10, now, now],
    );
  }
}

async function seedSettings(): Promise<void> {
  const now = nowISO();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run(
      `INSERT INTO settings (setting_key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO NOTHING`,
      [key, JSON.stringify(value), now],
    );
  }
}

async function seedAdmin(): Promise<void> {
  const now = nowISO();
  const adminRole = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', ['ADMIN']);
  if (!adminRole) return;
  const existing = await get<{ id: number }>(
    'SELECT id FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL',
    [config.admin.email],
  );
  if (existing) return;
  await run(
    `INSERT INTO users (name, email, phone, username, password_hash, role_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      config.admin.name,
      config.admin.email.toLowerCase(),
      null,
      'admin',
      hashPassword(config.admin.password),
      adminRole.id,
      now,
      now,
    ],
  );
}

export async function seed(): Promise<void> {
  await seedRbac();
  await seedStatuses();
  await seedSources();
  await seedSettings();
  await seedAdmin();
}

export function permissionCodes(): string[] {
  return ALL_PERMISSION_CODES;
}

export { randomToken };
