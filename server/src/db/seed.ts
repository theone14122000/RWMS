import { all, get, nowISO, run, tx } from './database.js';
import { config } from '../config.js';
import { hashPassword, randomToken } from '../lib/password.js';
import { ALL_PERMISSION_CODES, PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '../lib/permissions.js';
import { addDays, todayStr } from '../lib/dates.js';

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

/* ------------------------------------------------------------------ */
/* Optional demo dataset (development only)                            */
/* ------------------------------------------------------------------ */

const DEMO_CUSTOMERS = [
  { name: 'Aarav Sharma', phone: '9811012345', whatsapp: '919811012345', email: 'aarav.sharma@example.com', city: 'Delhi', state: 'Delhi', country: 'India' },
  { name: 'Priya Nair', phone: '9822023456', whatsapp: '919822023456', email: 'priya.nair@example.com', city: 'Kochi', state: 'Kerala', country: 'India' },
  { name: 'Rohan Mehta', phone: '9833034567', whatsapp: '919833034567', email: 'rohan.mehta@example.com', city: 'Mumbai', state: 'Maharashtra', country: 'India' },
  { name: 'Sneha Iyer', phone: '9844045678', whatsapp: '919844045678', email: 'sneha.iyer@example.com', city: 'Chennai', state: 'Tamil Nadu', country: 'India' },
  { name: 'Vikram Singh', phone: '9855056789', whatsapp: '919855056789', email: 'vikram.singh@example.com', city: 'Jaipur', state: 'Rajasthan', country: 'India' },
  { name: 'Ananya Das', phone: '9866067890', whatsapp: '919866067890', email: 'ananya.das@example.com', city: 'Kolkata', state: 'West Bengal', country: 'India' },
  { name: 'Kabir Malhotra', phone: '9877078901', whatsapp: '919877078901', email: 'kabir.malhotra@example.com', city: 'Chandigarh', state: 'Punjab', country: 'India' },
  { name: 'Meera Krishnan', phone: '9888089012', whatsapp: '919888089012', email: 'meera.krishnan@example.com', city: 'Bengaluru', state: 'Karnataka', country: 'India' },
];

const DEMO_LEADS = [
  { dest: 'Goa', travel: 'DOMESTIC', trip: 'Family', budget: 45000, status: 'CONTACTED', src: 'Website' },
  { dest: 'Kashmir', travel: 'DOMESTIC', trip: 'Couple', budget: 72000, status: 'FOLLOW_UP', src: 'Instagram' },
  { dest: 'Dubai', travel: 'INTERNATIONAL', trip: 'Honeymoon', budget: 185000, status: 'QUOTATION_SENT', src: 'Google Ads' },
  { dest: 'Bali', travel: 'INTERNATIONAL', trip: 'Couple', budget: 210000, status: 'NEGOTIATION', src: 'Referral' },
  { dest: 'Manali', travel: 'DOMESTIC', trip: 'Adventure', budget: 38000, status: 'INTERESTED', src: 'WhatsApp' },
  { dest: 'Kerala', travel: 'DOMESTIC', trip: 'Family', budget: 65000, status: 'CONVERTED', src: 'Existing Customer' },
  { dest: 'Thailand', travel: 'INTERNATIONAL', trip: 'Group', budget: 150000, status: 'NEW', src: 'Facebook' },
  { dest: 'Rajasthan', travel: 'DOMESTIC', trip: 'Pilgrimage', budget: 52000, status: 'ASSIGNED', src: 'Walk-in' },
  { dest: 'Singapore', travel: 'INTERNATIONAL', trip: 'Corporate', budget: 320000, status: 'CONTACTED', src: 'Partner' },
  { dest: 'Ladakh', travel: 'DOMESTIC', trip: 'Trekking', budget: 58000, status: 'FOLLOW_UP', src: 'Phone' },
  { dest: 'Europe', travel: 'INTERNATIONAL', trip: 'Luxury', budget: 650000, status: 'QUOTATION_SENT', src: 'Google Business' },
  { dest: 'Andaman', travel: 'DOMESTIC', trip: 'Honeymoon', budget: 88000, status: 'NOT_INTERESTED', src: 'Website' },
  { dest: 'Vietnam', travel: 'INTERNATIONAL', trip: 'Budget', budget: 95000, status: 'NO_RESPONSE', src: 'Instagram' },
  { dest: 'Shimla', travel: 'DOMESTIC', trip: 'Family', budget: 41000, status: 'NEW', src: 'Manual Entry' },
  { dest: 'Maldives', travel: 'INTERNATIONAL', trip: 'Honeymoon', budget: 390000, status: 'INTERESTED', src: 'Referral' },
  { dest: 'Meghalaya', travel: 'DOMESTIC', trip: 'Adventure', budget: 47000, status: 'NEW', src: 'WhatsApp' },
];

const TRAVEL_START = addDays(todayStr(), 21);

async function seedDemoData(): Promise<void> {
  if (!config.seedDemoData) return;
  const already = await get<{ value: string }>('SELECT value FROM settings WHERE setting_key = ?', ['demo_seeded']);
  if (already) return;

  const now = nowISO();
  const workerRole = await get<{ id: number }>('SELECT id FROM roles WHERE code = ?', ['WORKER']);
  const admin = await get<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [config.admin.email]);
  if (!workerRole || !admin) return;

  await tx(async () => {
    const workers: number[] = [];
    const demoWorkers = [
      { name: 'Rahul Verma', email: 'rahul@travelcrm.local', username: 'rahul', phone: '9000000001' },
      { name: 'Aman Gupta', email: 'aman@travelcrm.local', username: 'aman', phone: '9000000002' },
      { name: 'Kavya Reddy', email: 'kavya@travelcrm.local', username: 'kavya', phone: '9000000003' },
    ];
    for (const w of demoWorkers) {
      const existing = await get<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [w.email]);
      if (existing) {
        workers.push(existing.id);
        continue;
      }
      const res = await run(
        `INSERT INTO users (name, email, phone, username, password_hash, role_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [w.name, w.email, w.phone, w.username, hashPassword('Worker@1234!'), workerRole.id, now, now],
      );
      workers.push(res.lastInsertRowid);
    }

    const customerIds: number[] = [];
    for (const c of DEMO_CUSTOMERS) {
      const res = await run(
        `INSERT INTO customers (name, phone, whatsapp, email, city, state, country, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.name, c.phone, c.whatsapp, c.email, c.city, c.state, c.country, null, admin.id, now, now],
      );
      customerIds.push(res.lastInsertRowid);
    }

    const sources = await all<{ id: number; name: string }>('SELECT id, name FROM lead_sources WHERE is_active = 1');
    const sourceMap = new Map(sources.map((s) => [s.name, s.id]));
    const statuses = await all<{ id: number; code: string }>('SELECT id, code FROM lead_statuses');
    const statusMap = new Map(statuses.map((s) => [s.code, s.id]));
    const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

    for (const [i, l] of DEMO_LEADS.entries()) {
      const customerId = customerIds[i % customerIds.length];
      const assignee = i % 7 === 3 ? null : workers[i % workers.length];
      const statusId = statusMap.get(l.status) ?? statusMap.get('NEW')!;
      const leadRes = await run(
        `INSERT INTO leads (lead_number, customer_id, source_id, assigned_to, destination, travel_type, trip_type,
           requirements, travel_start_date, travel_end_date, duration_days, adults, children, total_travelers,
           budget, currency, priority, status_id, last_contacted_at, next_follow_up_at, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `LD-${String(i + 1).padStart(4, '0')}`,
          customerId,
          sourceMap.get(l.src) ?? null,
          assignee,
          l.dest,
          l.travel,
          l.trip,
          JSON.stringify(i % 3 === 0 ? ['Hotel', 'Cab', 'Sightseeing'] : ['Complete Package']),
          TRAVEL_START,
          addDays(TRAVEL_START, 5),
          6,
          2,
          i % 4 === 0 ? 1 : 0,
          i % 4 === 0 ? 3 : 2,
          l.budget,
          priorities[i % priorities.length],
          statusId,
          now,
          addDays(todayStr(), i % 5),
          admin.id,
          admin.id,
          now,
          now,
        ],
      );
      const leadId = leadRes.lastInsertRowid;

      if (assignee) {
        await run(
          `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, action, assigned_at, is_active)
           VALUES (?, ?, ?, 'ASSIGNED', ?, 1)`,
          [leadId, assignee, admin.id, now],
        );
        await run(
          `INSERT INTO lead_timeline (lead_id, type, actor_id, summary, metadata, created_at)
           VALUES (?, 'LEAD_CREATED', ?, ?, '{}', ?)`,
          [leadId, admin.id, `Lead ${leadId} created`, now],
        );
        await run(
          `INSERT INTO lead_timeline (lead_id, type, actor_id, summary, metadata, created_at)
           VALUES (?, 'ASSIGNED', ?, ?, '{}', ?)`,
          [leadId, admin.id, 'Lead assigned', now],
        );
      }

      if (i % 3 !== 2) {
        const offset = i % 5;
        const fuDate = offset === 0 ? todayStr() : offset === 1 ? addDays(todayStr(), -2) : addDays(todayStr(), offset - 1);
        const fuStatus = offset === 1 ? 'PENDING' : offset === 0 ? 'PENDING' : i % 6 === 0 ? 'CONVERTED' : 'COMPLETED';
        await run(
          `INSERT INTO follow_ups (lead_id, worker_id, scheduled_date, scheduled_time, type, status, notes,
             next_action, created_by, created_at, completed_by, completed_at, updated_at)
           VALUES (?, ?, ?, ?, 'Call', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            leadId,
            assignee ?? workers[i % workers.length],
            fuDate,
            `${9 + (i % 8)}:30`,
            fuStatus,
            'Discuss itinerary and pricing with customer.',
            fuStatus === 'COMPLETED' || fuStatus === 'CONVERTED' ? 'Send final quotation' : 'Call back',
            admin.id,
            now,
            fuStatus === 'COMPLETED' || fuStatus === 'CONVERTED' ? (assignee ?? workers[i % workers.length]) : null,
            fuStatus === 'COMPLETED' || fuStatus === 'CONVERTED' ? now : null,
            now,
          ],
        );
      }

      await run(
        `INSERT INTO notes (lead_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [leadId, admin.id, `Customer enquiry for ${l.dest}. Budget discussed: INR ${l.budget}.`, now, now],
      );
    }

    await run(
      `INSERT INTO settings (setting_key, value, updated_at) VALUES ('demo_seeded', ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(true), now],
    );
  });
}

export async function seed(): Promise<void> {
  await seedRbac();
  await seedStatuses();
  await seedSources();
  await seedSettings();
  await seedAdmin();
  await seedDemoData();
}

export function permissionCodes(): string[] {
  return ALL_PERMISSION_CODES;
}

export { randomToken };
