import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, closeHarness, createClient, createCustomer, createLead, createWorkerClient, randomSuffix } from './helpers/harness.js';

after(closeHarness);

async function adminClient() {
  const client = createClient();
  await client.login(ADMIN.email, ADMIN.password);
  return client;
}

describe('leads', () => {
  it('creates a lead with a unique lead number and NEW status', async () => {
    const admin = await adminClient();
    const customer = await createCustomer(admin);

    const res = await admin.post('/api/leads', {
      customer_id: customer.id,
      destination: 'Manali',
      travel_type: 'DOMESTIC',
      trip_type: 'Adventure',
      requirements: ['Hotel', 'Cab'],
      adults: 2,
      children: 1,
      budget: 45000,
      currency: 'INR',
      priority: 'HIGH',
      travel_start_date: '2026-11-10',
      travel_end_date: '2026-11-15',
      duration_days: 5,
      notes: 'First enquiry from website',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.data.lead_number, /^LD-\d{6}-\d{4}$/);
    assert.equal(res.body.data.destination, 'Manali');
    assert.equal(res.body.data.status.code, 'NEW');
    assert.equal(res.body.data.total_travelers, 3);
    assert.deepEqual(res.body.data.requirements, ['Hotel', 'Cab']);

    const second = await createLead(admin, { destination: 'Leh' });
    assert.notEqual(second.lead_number, res.body.data.lead_number);
  });

  it('validates lead input', async () => {
    const admin = await adminClient();
    const customer = await createCustomer(admin);

    const noCustomer = await admin.post('/api/leads', { destination: 'Goa', travel_type: 'DOMESTIC' });
    assert.equal(noCustomer.status, 400);

    const badDates = await admin.post('/api/leads', {
      customer_id: customer.id,
      destination: 'Goa',
      travel_type: 'DOMESTIC',
      travel_start_date: '2026-12-10',
      travel_end_date: '2026-12-01',
    });
    assert.equal(badDates.status, 400);

    const badTravelType = await admin.post('/api/leads', {
      customer_id: customer.id,
      destination: 'Goa',
      travel_type: 'SPACE',
    });
    assert.equal(badTravelType.status, 400);
  });

  it('creates an inline customer unless duplicates need confirming', async () => {
    const admin = await adminClient();
    const phone = `97${String(Date.now()).slice(-8)}`;

    await createCustomer(admin, { phone });

    const dup = await admin.post('/api/leads', {
      customer: { name: 'Inline Dup', phone },
      destination: 'Kochi',
      travel_type: 'DOMESTIC',
    });
    assert.equal(dup.status, 409);

    const ok = await admin.post('/api/leads', {
      customer: { name: `Inline ${randomSuffix()}`, phone: `96${String(Date.now()).slice(-8)}` },
      destination: 'Kochi',
      travel_type: 'DOMESTIC',
      allow_duplicate: true,
    });
    assert.equal(ok.status, 201);
  });

  it('assigns, reassigns and keeps a full assignment history', async () => {
    const admin = await adminClient();
    const first = await createWorkerClient(admin);
    const second = await createWorkerClient(admin);

    const lead = await createLead(admin, { destination: 'Agra' });
    const assign = await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: first.id, reason: 'north region' });
    assert.equal(assign.status, 200);
    assert.equal(assign.body.data.assignee.id, first.id);
    assert.equal(assign.body.data.status.code, 'ASSIGNED', 'NEW leads auto-promote on first assignment');

    const reassigned = await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: second.id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.data.assignee.id, second.id);

    const history = await admin.get(`/api/leads/${lead.id}/assignments`);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].action, 'REASSIGNED');
    assert.equal(history.body.data[1].action, 'ASSIGNED');
    assert.equal(history.body.data[1].is_active, 0);

    const unassigned = await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: null });
    assert.equal(unassigned.body.data.assignee, null);

    const timeline = await admin.get(`/api/leads/${lead.id}/timeline`);
    const types = timeline.body.data.map((e: any) => e.type);
    assert.ok(types.includes('ASSIGNED'));
    assert.ok(types.includes('REASSIGNED'));
    assert.ok(types.includes('UNASSIGNED'));
    assert.ok(types.includes('STATUS_CHANGED'));
  });

  it('bulk assigns several leads to one worker', async () => {
    const admin = await adminClient();
    const worker = await createWorkerClient(admin);
    const a = await createLead(admin, { destination: 'Bengaluru' });
    const b = await createLead(admin, { destination: 'Hyderabad' });

    const res = await admin.post('/api/leads/bulk/assign', {
      lead_ids: [a.id, b.id],
      worker_id: worker.id,
      reason: 'bulk load',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.assigned, 2);
    assert.equal(res.body.data.failed.length, 0);

    const detailA = await admin.get(`/api/leads/${a.id}`);
    const detailB = await admin.get(`/api/leads/${b.id}`);
    assert.equal(detailA.body.data.assignee.id, worker.id);
    assert.equal(detailB.body.data.assignee.id, worker.id);
  });

  it('records status changes with history and timeline entries', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin, { destination: 'Varanasi' });

    const changed = await admin.post(`/api/leads/${lead.id}/status`, {
      status: 'CONTACTED',
      remark: 'Spoke to the customer',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.status.code, 'CONTACTED');

    const again = await admin.post(`/api/leads/${lead.id}/status`, { status: 'CONTACTED' });
    assert.equal(again.status, 200, 'no-op status changes are accepted');

    const bad = await admin.post(`/api/leads/${lead.id}/status`, { status: 'NOT_A_STATUS' });
    assert.equal(bad.status, 400);

    const timeline = await admin.get(`/api/leads/${lead.id}/timeline`);
    const statusEvents = timeline.body.data.filter((e: any) => e.type === 'STATUS_CHANGED');
    assert.ok(statusEvents.length >= 1);
    assert.match(statusEvents[0].summary, /CONTACTED/);
  });

  it('updates editable lead fields and blocks unknown ones', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin, { destination: 'Kanyakumari' });

    const patched = await admin.patch(`/api/leads/${lead.id}`, {
      destination: 'Kanyakumari Beach',
      budget: 65000,
      priority: 'URGENT',
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.destination, 'Kanyakumari Beach');
    assert.equal(patched.body.data.budget, 65000);
    assert.equal(patched.body.data.priority, 'URGENT');

    const missing = await admin.get('/api/leads/9999999');
    assert.equal(missing.status, 404);
  });

  it('filters, searches and paginates leads', async () => {
    const admin = await adminClient();
    const marker = `Zzyzx${randomSuffix()}`;
    await createLead(admin, { destination: marker, priority: 'URGENT' });
    await createLead(admin, { destination: marker, priority: 'LOW' });

    const search = await admin.get(`/api/leads?search=${marker}`);
    assert.equal(search.body.meta.total, 2);

    const urgent = await admin.get(`/api/leads?search=${marker}&priority=URGENT`);
    assert.equal(urgent.body.meta.total, 1);
    assert.equal(urgent.body.data[0].priority, 'URGENT');

    const paged = await admin.get('/api/leads?limit=1&page=1');
    assert.equal(paged.body.data.length, 1);
    assert.equal(paged.body.meta.limit, 1);

    const unassigned = await admin.get('/api/leads?assigned=unassigned&limit=1');
    assert.equal(unassigned.status, 200);
    assert.ok(unassigned.body.data.every((l: any) => l.assignee === null));
  });

  it('warns about duplicate leads for an existing customer', async () => {
    const admin = await adminClient();
    const customer = await createCustomer(admin, { phone: `95${String(Date.now()).slice(-8)}` });
    await createLead(admin, { customer_id: customer.id, destination: 'Goa' });

    const check = await admin.get(`/api/leads/check-duplicate?phone=${customer.phone}`);
    assert.equal(check.status, 200);
    assert.equal(check.body.data.is_duplicate, true);
    assert.ok(check.body.data.leads.length >= 1);
  });

  it('adds notes to a lead and lists them newest first', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin, { destination: 'Shimla' });

    const first = await admin.post(`/api/leads/${lead.id}/notes`, { content: 'Wants a 4 night package.' });
    assert.equal(first.status, 201);
    const second = await admin.post(`/api/leads/${lead.id}/notes`, { content: 'Budget capped at 60k.' });
    assert.equal(second.status, 201);

    const notes = await admin.get(`/api/leads/${lead.id}/notes`);
    assert.equal(notes.body.data.length, 2);
    assert.equal(notes.body.data[0].content, 'Budget capped at 60k.');
    assert.equal(notes.body.data[0].author_name, 'System Owner');

    const empty = await admin.post(`/api/leads/${lead.id}/notes`, { content: '   ' });
    assert.equal(empty.status, 400);

    const timeline = await admin.get(`/api/leads/${lead.id}/timeline`);
    assert.ok(timeline.body.data.some((e: any) => e.type === 'NOTE_ADDED'));
  });
});
