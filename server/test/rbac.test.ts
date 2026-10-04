import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  closeHarness,
  createClient,
  createCustomer,
  createLead,
  createWorkerClient,
} from './helpers/harness.js';

after(closeHarness);

describe('role based access control', () => {
  it('denies workers the admin-only endpoints', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const { client: worker } = await createWorkerClient(admin);

    const cases: Array<[string, string, unknown]> = [
      ['GET', '/api/users', undefined],
      ['POST', '/api/users', { name: 'X', email: 'x@y.local', password: 'Pass1234' }],
      ['GET', '/api/audit-logs', undefined],
      ['GET', '/api/audit-logs/actions', undefined],
      ['GET', '/api/meta/settings', undefined],
      ['PATCH', '/api/meta/settings/trip_types', { value: ['Family'] }],
      ['POST', '/api/leads', { customer_id: 1, destination: 'Goa', travel_type: 'DOMESTIC' }],
      ['POST', '/api/customers', { name: 'Sneaky' }],
    ];

    for (const [method, path, body] of cases) {
      const res = await worker.request(path, { method, body });
      assert.equal(res.status, 403, `${method} ${path} should be 403, got ${res.status}`);
      assert.equal(res.body.error.code, 'FORBIDDEN', `${method} ${path} error code`);
    }
  });

  it('scopes a worker to their own leads only', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);
    const other = await createWorkerClient(admin);

    const mine = await createLead(admin, { destination: 'Worker Lead' });
    await createLead(admin, { destination: 'Other Worker Lead', assigned_to: other.id });
    const unassigned = await createLead(admin, { destination: 'Nobody Lead' });

    await admin.post(`/api/leads/${mine.id}/assign`, { worker_id: worker.id });

    const list = await worker.client.get('/api/leads?limit=100');
    assert.equal(list.status, 200);
    const ids = list.body.data.map((l: any) => l.id);
    assert.ok(ids.includes(mine.id), 'assigned lead visible');
    assert.ok(!ids.includes(unassigned.id), 'unassigned lead hidden');
    assert.equal(
      list.body.data.every((l: any) => l.assignee?.id === worker.id),
      true,
      'worker never sees leads owned by others',
    );

    const all = await admin.get('/api/leads?limit=100');
    assert.equal(all.body.meta.total >= list.body.meta.total, true);
  });

  it('blocks cross-worker lead detail, status changes and follow-ups', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);
    const other = await createWorkerClient(admin);

    const lead = await createLead(admin, { destination: 'Srinagar' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });

    assert.equal((await worker.client.get(`/api/leads/${lead.id}`)).status, 200);

    const foreignLead = await createLead(admin, { destination: 'Pune' });
    await admin.post(`/api/leads/${foreignLead.id}/assign`, { worker_id: other.id });

    assert.equal((await worker.client.get(`/api/leads/${foreignLead.id}`)).status, 403);
    assert.equal(
      (await worker.client.post(`/api/leads/${foreignLead.id}/status`, { status: 'CONTACTED' })).status,
      403,
    );
    assert.equal(
      (await worker.client.patch(`/api/leads/${foreignLead.id}`, { destination: 'Hacked' })).status,
      403,
    );
    assert.equal(
      (await worker.client.post('/api/follow-ups', {
        lead_id: foreignLead.id,
        scheduled_date: '2026-10-10',
        type: 'Call',
      })).status,
      403,
    );
    assert.equal((await worker.client.post(`/api/leads/${foreignLead.id}/assign`, { worker_id: worker.id })).status, 403);
    assert.equal((await worker.client.get(`/api/leads/${foreignLead.id}/notes`)).status, 403);
  });

  it('lets a worker manage their own lead and follow-ups', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);

    const lead = await createLead(admin, { destination: 'Alleppey' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });

    const status = await worker.client.post(`/api/leads/${lead.id}/status`, {
      status: 'CONTACTED',
      remark: 'Called the customer',
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status.code, 'CONTACTED');

    const note = await worker.client.post(`/api/leads/${lead.id}/notes`, { content: 'Customer prefers a lake view.' });
    assert.equal(note.status, 201);

    const fu = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: '2026-10-10',
      scheduled_time: '11:00',
      type: 'WhatsApp',
      notes: 'Send itinerary',
    });
    assert.equal(fu.status, 201);
    assert.equal(fu.body.data.worker.id, worker.id);
  });

  it('prevents workers from assigning follow-ups to other workers', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);
    const other = await createWorkerClient(admin);

    const lead = await createLead(admin, { destination: 'Coorg' });
    await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });

    const res = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      worker_id: other.id,
      scheduled_date: '2026-10-12',
      type: 'Call',
    });
    assert.equal(res.status, 403);
  });

  it('keeps worker customer lists scoped to their own leads', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);
    const other = await createWorkerClient(admin);

    const ownCustomer = await createCustomer(admin, { name: 'Own Customer' });
    const foreignCustomer = await createCustomer(admin, { name: 'Foreign Customer' });
    const ownLead = await createLead(admin, { customer_id: ownCustomer.id, destination: 'Mysuru' });
    await createLead(admin, { customer_id: foreignCustomer.id, destination: 'Hubli', assigned_to: other.id });
    await admin.post(`/api/leads/${ownLead.id}/assign`, { worker_id: worker.id });

    const list = await worker.client.get('/api/customers?limit=100');
    assert.equal(list.status, 200);
    const ids = list.body.data.map((c: any) => c.id);
    assert.ok(ids.includes(ownCustomer.id));
    assert.ok(!ids.includes(foreignCustomer.id));

    const adminList = await admin.get('/api/customers?limit=100');
    assert.ok(adminList.body.data.some((c: any) => c.id === foreignCustomer.id));
  });

  it('grants admins the management permissions', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    assert.equal((await admin.get('/api/users')).status, 200);
    assert.equal((await admin.get('/api/audit-logs')).status, 200);
    assert.equal((await admin.get('/api/meta/settings')).status, 200);
    assert.equal((await admin.get('/api/dashboard/admin')).status, 200);
  });

  it('never exposes a hard-delete endpoint for leads, customers or workers', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const customer = await createCustomer(admin);
    const lead = await createLead(admin, { customer_id: customer.id });
    const { id: workerId } = await createWorkerClient(admin);

    for (const path of [`/api/leads/${lead.id}`, `/api/customers/${customer.id}`, `/api/users/${workerId}`]) {
      const res = await admin.delete(path);
      assert.equal(res.status, 404, `DELETE ${path} must not exist`);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
  });
});
