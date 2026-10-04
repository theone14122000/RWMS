import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, closeHarness, createClient, createLead, randomSuffix } from './helpers/harness.js';

after(closeHarness);

async function adminClient() {
  const client = createClient();
  await client.login(ADMIN.email, ADMIN.password);
  return client;
}

describe('customers', () => {
  it('creates and validates customers', async () => {
    const admin = await adminClient();

    const created = await admin.post('/api/customers', {
      name: 'Neha Kapoor',
      phone: '9810011122',
      email: `neha-${randomSuffix()}@example.com`,
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
      notes: 'Prefers window seats',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.name, 'Neha Kapoor');
    assert.equal(created.body.data.lead_count, 0);

    const invalid = await admin.post('/api/customers', { name: 'A' });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error.details.some((d: any) => d.message.includes('2 characters')));

    const badEmail = await admin.post('/api/customers', { name: 'Valid Name', email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
  });

  it('detects duplicates and requires an explicit override', async () => {
    const admin = await adminClient();
    const phone = `98${String(Date.now()).slice(-8)}`;

    const email = `dup-${randomSuffix()}@example.com`;
    const first = await admin.post('/api/customers', { name: 'Duplicate Probe', phone, email });
    assert.equal(first.status, 201);

    const check = await admin.get(`/api/customers/check-duplicate?phone=${phone}`);
    assert.equal(check.status, 200);
    assert.equal(check.body.data.is_duplicate, true);
    assert.equal(check.body.data.duplicates[0].id, first.body.data.id);

    const conflict = await admin.post('/api/customers', { name: 'Duplicate Probe Two', phone });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'CONFLICT');
    assert.ok(conflict.body.error.details.duplicates.length > 0);

    const allowed = await admin.post('/api/customers', {
      name: 'Duplicate Probe Two',
      phone,
      allow_duplicate: true,
    });
    assert.equal(allowed.status, 201);

    const byEmail = await admin.post('/api/customers', {
      name: 'Email Duplicate',
      email: first.body.data.email,
    });
    assert.equal(byEmail.status, 409, 'duplicate email is also rejected');
  });

  it('supports search, sorting and pagination', async () => {
    const admin = await adminClient();
    const marker = `Paginatee${randomSuffix()}`;
    await admin.post('/api/customers', { name: marker, phone: '9700000001' });
    await admin.post('/api/customers', { name: marker, phone: '9700000002' });

    const page1 = await admin.get('/api/customers?limit=1&page=1');
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 1);
    assert.equal(page1.body.meta.limit, 1);
    assert.equal(page1.body.meta.total_pages >= 1, true);

    const page2 = await admin.get('/api/customers?limit=1&page=2');
    assert.notEqual(page1.body.data[0].id, page2.body.data[0].id);

    const search = await admin.get(`/api/customers?search=${marker}`);
    assert.equal(search.body.meta.total, 2);

    const sorted = await admin.get('/api/customers?sort=name&limit=5');
    const names = sorted.body.data.map((c: any) => c.name);
    assert.deepEqual(names, [...names].sort((a: string, b: string) => a.localeCompare(b)));
  });

  it('updates a customer and returns the detail view', async () => {
    const admin = await adminClient();
    const created = await admin.post('/api/customers', { name: 'Rename Me', phone: '9611111111' });
    const id = created.body.data.id;

    const patched = await admin.patch(`/api/customers/${id}`, { name: 'Renamed Person', city: 'Nagpur' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.name, 'Renamed Person');
    assert.equal(patched.body.data.city, 'Nagpur');

    const detail = await admin.get(`/api/customers/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.lead_count, 0);

    const missing = await admin.get('/api/customers/9999999');
    assert.equal(missing.status, 404);
  });

  it('refuses to archive a customer with active leads, then archives an idle one', async () => {
    const admin = await adminClient();
    const withLead = await admin.post('/api/customers', { name: 'Busy Customer', phone: '9522222222' });
    await createLead(admin, { customer_id: withLead.body.data.id, destination: 'Rishikesh' });

    const blocked = await admin.post(`/api/customers/${withLead.body.data.id}/archive`);
    assert.equal(blocked.status, 409);

    const idle = await admin.post('/api/customers', { name: 'Idle Customer', phone: '9533333333' });
    const archived = await admin.post(`/api/customers/${idle.body.data.id}/archive`);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.data.archived, true);

    const gone = await admin.get(`/api/customers/${idle.body.data.id}`);
    assert.equal(gone.status, 404);

    const list = await admin.get('/api/customers?limit=200');
    assert.ok(!list.body.data.some((c: any) => c.id === idle.body.data.id), 'archived customer hidden from list');
  });

  it('keeps lead counts in sync with customers', async () => {
    const admin = await adminClient();
    const customer = await admin.post('/api/customers', { name: 'Counted Customer', phone: '9444444444' });
    const id = customer.body.data.id;

    await createLead(admin, { customer_id: id, destination: 'Darjeeling' });
    await createLead(admin, { customer_id: id, destination: 'Gangtok' });

    const detail = await admin.get(`/api/customers/${id}`);
    assert.equal(detail.body.data.lead_count, 2);
  });
});
