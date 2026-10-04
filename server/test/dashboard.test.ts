import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  closeHarness,
  createClient,
  createLead,
  createWorkerClient,
  day,
  today,
} from './helpers/harness.js';

after(closeHarness);

async function adminClient() {
  const client = createClient();
  await client.login(ADMIN.email, ADMIN.password);
  return client;
}

describe('dashboards', () => {
  it('returns admin KPIs, charts and action lists', async () => {
    const admin = await adminClient();
    const res = await admin.get('/api/dashboard/admin');
    assert.equal(res.status, 200);

    const { totals, charts, lists, filters } = res.body.data;
    for (const key of [
      'total_leads',
      'new_leads',
      'unassigned_leads',
      'assigned_leads',
      'open_leads',
      'conversions',
      'not_interested',
      'todays_follow_ups',
      'overdue_follow_ups',
      'total_follow_ups',
      'active_workers',
    ]) {
      assert.equal(typeof totals[key], 'number', `totals.${key} must be a number`);
    }

    assert.ok(Array.isArray(charts.leads_by_status));
    assert.ok(Array.isArray(charts.leads_by_source));
    assert.ok(charts.leads_trend.length >= 1);
    assert.equal(typeof charts.leads_trend[0].count, 'number');
    assert.ok(Array.isArray(charts.follow_up_outcomes));

    assert.ok(Array.isArray(lists.recent_leads));
    assert.ok(Array.isArray(lists.todays_follow_ups));
    assert.ok(Array.isArray(lists.overdue_follow_ups));
    assert.ok(Array.isArray(lists.unassigned_leads));
    assert.equal(filters.today, today);
  });

  it('scopes admin dashboard counts to filters', async () => {
    const admin = await adminClient();
    const unfiltered = await admin.get('/api/dashboard/admin');
    const filtered = await admin.get('/api/dashboard/admin?period=7d');
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.data.totals.total_leads <= unfiltered.body.data.totals.total_leads);
  });

  it('returns a worker dashboard for the logged-in worker only', async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    const lead = await createLead(admin, { destination: 'Worker Dash Lead' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: today, type: 'Call' });

    const res = await worker.client.get('/api/dashboard/worker');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.data.stats.pending_leads, 'number');
    assert.ok(res.body.data.stats.pending_leads >= 1);
    assert.ok(res.body.data.stats.today_follow_ups >= 1);
    assert.ok(Array.isArray(res.body.data.lists.today_follow_ups));
    assert.ok(res.body.data.lists.today_follow_ups.some((f: any) => f.lead_id === lead.id));

    const asAdmin = await admin.get('/api/dashboard/worker');
    assert.equal(asAdmin.status, 200, 'admins may preview the worker dashboard');
  });
});

describe('workload', () => {
  it('reports assigned vs completed vs pending vs overdue per worker', async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    const lead = await createLead(admin, { destination: 'Load Lead' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });

    const res = await admin.get('/api/workload');
    assert.equal(res.status, 200);
    const row = res.body.data.rows.find((r: any) => r.worker_id === worker.id);
    assert.ok(row, 'worker appears in workload');
    assert.equal(row.assigned, 1);
    assert.equal(row.pending, 1);
    assert.equal(row.completed, 0);
    assert.equal(typeof row.follow_ups_today, 'number');
    assert.ok(Array.isArray(res.body.data.rows));
    for (const key of ['assigned', 'completed', 'pending', 'overdue', 'converted']) {
      assert.equal(typeof res.body.data.totals[key], 'number', `totals.${key}`);
    }
  });

  it('supports status and period filters', async () => {
    const admin = await adminClient();
    const active = await admin.get('/api/workload?status=ACTIVE');
    assert.equal(active.status, 200);
    assert.ok(active.body.data.rows.every((r: any) => r.status === 'ACTIVE'));

    const period = await admin.get('/api/workload?period=7d');
    assert.equal(period.status, 200);
    assert.ok(period.body.data.period.from <= period.body.data.period.to);
  });

  it("returns today's queue for a chosen worker", async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    const otherWorker = await createWorkerClient(admin);
    const lead = await createLead(admin, { destination: 'Queue Lead' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: today, type: 'Call' });
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: day(5), type: 'Email' });

    const res = await admin.get(`/api/workload/today?worker_id=${worker.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((l: any) => l.id === lead.id));
    assert.ok(res.body.data.every((l: any) => l.next_fu_date === today));

    const own = await worker.client.get('/api/workload/today');
    assert.equal(own.status, 200);
    assert.ok(own.body.data.some((l: any) => l.id === lead.id));
    assert.equal(own.body.data.length >= 1, true);

    const foreign = await admin.get(`/api/workload/today?worker_id=${otherWorker.id}`);
    assert.ok(!foreign.body.data.some((l: any) => l.id === lead.id), 'queue is per worker');
  });

  it('scopes the workload view of a worker to themselves', async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    await createWorkerClient(admin);

    const res = await worker.client.get('/api/workload');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.rows.length, 1);
    assert.equal(res.body.data.rows[0].worker_id, worker.id);
  });
});

describe('audit, meta, notifications and activity', () => {
  it('records login and lead events in the audit log', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin, { destination: 'Audited Lead' });

    const logs = await admin.get('/api/audit-logs?limit=100');
    assert.equal(logs.status, 200);
    assert.ok(logs.body.meta.total >= 1);
    const actions = logs.body.data.map((r: any) => r.action);
    assert.ok(actions.includes('LOGIN_SUCCESS'));
    assert.ok(actions.includes('LEAD_CREATED'));

    const filtered = await admin.get('/api/audit-logs?action=LEAD_CREATED');
    assert.ok(filtered.body.data.every((r: any) => r.action === 'LEAD_CREATED'));

    const searched = await admin.get(`/api/audit-logs?search=LEAD_CREATED`);
    assert.ok(searched.body.data.length >= 1);

    const byEntity = await admin.get('/api/audit-logs?entity=lead');
    assert.ok(byEntity.body.data.every((r: any) => r.entity === 'lead'));

    const actionsEndpoint = await admin.get('/api/audit-logs/actions');
    assert.equal(actionsEndpoint.status, 200);
    assert.ok(actionsEndpoint.body.data.some((a: any) => a.action === 'LOGIN_SUCCESS'));

    const entry = logs.body.data.find(
      (r: any) => r.entity === 'lead' && String(r.entity_id) === String(lead.id),
    );
    assert.ok(entry, 'lead creation audited with entity id');
    assert.equal(entry.user_name, 'System Owner');
  });

  it('exposes the reference meta used by every form', async () => {
    const admin = await adminClient();
    const res = await admin.get('/api/meta');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.statuses.length >= 12);
    assert.ok(res.body.data.sources.length >= 13);
    assert.ok(res.body.data.options.priorities.length >= 4);
    assert.ok(res.body.data.options.trip_types.length >= 1);
    assert.ok(res.body.data.options.requirements_options.length >= 1);
    assert.ok(res.body.data.options.follow_up_types.length >= 1);
    assert.ok(res.body.data.options.currencies.includes('INR'));
    assert.ok(res.body.data.statuses.every((s: any) => s.code && s.color));
    assert.ok(res.body.data.follow_up_board.length === 6);
  });

  it('lets admins maintain sources, statuses and settings', async () => {
    const admin = await adminClient();

    const source = await admin.post('/api/meta/sources', { name: `Channel ${today}` });
    assert.equal(source.status, 201);
    const toggled = await admin.patch(`/api/meta/sources/${source.body.data.id}`, { is_active: false });
    assert.equal(toggled.body.data.is_active, 0);

    const status = await admin.post('/api/meta/statuses', {
      code: `CUSTOM_${today.replace(/-/g, '')}`,
      name: 'Custom Status',
      category: 'OPEN',
      color: '#123456',
    });
    assert.equal(status.status, 201);

    const meta = await admin.get('/api/meta');
    assert.ok(meta.body.data.statuses.some((s: any) => s.id === status.body.data.id));

    const settings = await admin.get('/api/meta/settings');
    assert.equal(settings.status, 200);
    const tripTypes = settings.body.data.find((s: any) => s.key === 'trip_types');
    assert.ok(Array.isArray(tripTypes.value));

    const patched = await admin.patch('/api/meta/settings/trip_types', {
      value: [...tripTypes.value, 'Cruise'],
    });
    assert.equal(patched.status, 200);
    const after = await admin.get('/api/meta/settings');
    assert.ok(after.body.data.find((s: any) => s.key === 'trip_types').value.includes('Cruise'));

    const missing = await admin.patch('/api/meta/settings/not_a_key', { value: 1 });
    assert.equal(missing.status, 404);

    const cacheReset = await admin.post('/api/meta/permissions/cache/reset');
    assert.equal(cacheReset.status, 200);
    assert.equal(cacheReset.body.data.reset, true);
  });

  it('hands out and acknowledges notifications', async () => {
    const admin = await adminClient();
    const assignee = await createWorkerClient(admin);
    const other = await createWorkerClient(admin);
    const lead = await createLead(admin, { destination: 'Notify Lead' });

    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: assignee.id });

    const list = await assignee.client.get('/api/notifications');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((n: any) => n.type === 'LEAD_ASSIGNED'));
    assert.ok(list.body.meta.unread >= 1);

    const empty = await other.client.get('/api/notifications');
    assert.equal(empty.body.meta.unread, 0, 'notifications are per user');

    const readAll = await assignee.client.post('/api/notifications/read-all');
    assert.equal(readAll.status, 200);
    assert.ok(readAll.body.data.updated >= 1);

    const after = await assignee.client.get('/api/notifications');
    assert.equal(after.body.meta.unread, 0);
  });

  it('shows a worker their own activity trail', async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    const lead = await createLead(admin, { destination: 'Activity Lead' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });
    await worker.client.post(`/api/leads/${lead.id}/status`, { status: 'CONTACTED' });
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: today, type: 'Call' });
    await worker.client.post(`/api/leads/${lead.id}/notes`, { content: 'Called the customer.' });

    const own = await worker.client.get(`/api/users/${worker.id}/activity`);
    assert.equal(own.status, 200);
    assert.ok(own.body.data.length >= 3);
    assert.ok(own.body.data.every((e: any) => e.lead_id === lead.id));

    const someoneElse = await worker.client.get('/api/users/1/activity');
    assert.equal(someoneElse.status, 403, 'workers cannot read other people activity');

    const asAdmin = await admin.get(`/api/users/${worker.id}/activity`);
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.data.some((e: any) => e.type === 'NOTE_ADDED'));
  });

  it('rejects unknown API routes with a JSON 404', async () => {
    const admin = await adminClient();
    const res = await admin.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
