import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  closeHarness,
  createClient,
  createLead,
  createWorkerClient,
} from './helpers/harness.js';

after(closeHarness);

async function setup() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  const w = await createWorkerClient(admin);
  const lead = await createLead(admin, { destination: 'Quote Dest' });
  await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: w.id });
  return { admin, worker: w.client, workerId: w.id, lead };
}

async function makeQuotation(admin: any, lead: any, items: any[] = []) {
  const res = await admin.post('/api/quotations', {
    lead_id: lead.id,
    destination: lead.destination,
    items,
    inclusions: ['Hotel'],
    exclusions: ['Flights'],
    valid_until: '2030-12-31',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

describe('quotations', () => {
  it('creates a quotation with a server-computed total and numbering', async () => {
    const { admin, lead } = await setup();
    const q = await makeQuotation(admin, lead, [
      { description: 'Hotel', quantity: 2, unit_price: 5000 },
      { description: 'Transfer', quantity: 1, unit_price: 1500 },
    ]);
    assert.match(q.quotation_number, /^QT-\d{8}-\d{4}$/);
    assert.equal(q.total_amount, 11500, 'total computed from line items');
    assert.equal(q.status, 'DRAFT');
    assert.equal(q.customer_name != null, true);
  });

  it('walks valid status transitions and rejects invalid ones', async () => {
    const { admin, lead } = await setup();
    const q = await makeQuotation(admin, lead);

    const sent = await admin.post(`/api/quotations/${q.id}/status`, { status: 'SENT' });
    assert.equal(sent.status, 200);
    assert.ok(sent.body.data.sent_at);

    const accepted = await admin.post(`/api/quotations/${q.id}/status`, { status: 'ACCEPTED' });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.data.accepted_at);

    const invalid = await admin.post(`/api/quotations/${q.id}/status`, { status: 'SENT' });
    assert.equal(invalid.status, 409, 'accepted quotations cannot go back to sent');

    const history = accepted.body.data.status_history;
    assert.equal(history.length >= 2, true);
    assert.equal(history[0].from, 'DRAFT');
    assert.equal(history[0].to, 'SENT');
  });

  it('converts an accepted quotation into a booking and marks the lead converted', async () => {
    const { admin, lead } = await setup();
    const q = await makeQuotation(admin, lead, [{ description: 'Package', quantity: 1, unit_price: 25000 }]);
    await admin.post(`/api/quotations/${q.id}/status`, { status: 'SENT' });
    await admin.post(`/api/quotations/${q.id}/status`, { status: 'ACCEPTED' });

    const convert = await admin.post(`/api/quotations/${q.id}/convert`, {});
    assert.equal(convert.status, 201, JSON.stringify(convert.body));
    assert.ok(convert.body.data.booking_number);

    const bookingId = convert.body.data.booking_id;
    const booking = await admin.get(`/api/bookings/${bookingId}`);
    assert.equal(booking.status, 200);
    assert.equal(booking.body.data.quotation_id, q.id);
    assert.equal(booking.body.data.total_amount, 25000);
    assert.equal(booking.body.data.status, 'CONFIRMED');
    assert.equal(booking.body.data.payment_status, 'UNPAID');

    const leadAfter = await admin.get(`/api/leads/${lead.id}`);
    assert.equal(leadAfter.body.data.status?.code, 'CONVERTED');

    const twice = await admin.post(`/api/quotations/${q.id}/convert`, {});
    assert.equal(twice.status, 409, 'double conversion blocked');
  });

  it('scopes quotations for workers to their own records', async () => {
    const { admin, worker, workerId, lead } = await setup();
    const adminLead = await createLead(admin, { destination: 'Admin Owned Quote' });
    const q = await makeQuotation(admin, adminLead);

    const denied = await worker.get(`/api/quotations/${q.id}`);
    assert.equal(denied.status, 403, 'worker does not own this quotation');

    const mine = await worker.post('/api/quotations', {
      lead_id: lead.id,
      items: [{ description: 'Tour', quantity: 1, unit_price: 900 }],
    });
    assert.equal(mine.status, 201);
    assert.equal(mine.body.data.worker_id, workerId);

    const seen = await worker.get(`/api/quotations/${mine.body.data.id}`);
    assert.equal(seen.status, 200);

    const list = await worker.get('/api/quotations');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((r: any) => r.worker_id === workerId || r.created_by === workerId));
  });

  it('blocks workers from editing a rejected quotation while admins may override', async () => {
    const { admin, worker, lead } = await setup();
    const mine = await worker.post('/api/quotations', {
      lead_id: lead.id,
      items: [{ description: 'Tour', quantity: 1, unit_price: 1200 }],
    });
    assert.equal(mine.status, 201);
    const id = mine.body.data.id;

    await worker.post(`/api/quotations/${id}/status`, { status: 'SENT' });
    await worker.post(`/api/quotations/${id}/status`, { status: 'REJECTED' });

    const patch = await worker.patch(`/api/quotations/${id}`, { notes: 'changed' });
    assert.equal(patch.status, 409, 'closed quotations are read-only for workers');

    const adminPatch = await admin.patch(`/api/quotations/${id}`, { notes: 'admin correction' });
    assert.equal(adminPatch.status, 200, 'quotations:manage overrides the closed-state guard');
  });
});

describe('bookings and payments', () => {
  it('records payments and rolls up the payment status', async () => {
    const { admin, lead } = await setup();
    const bookingRes = await admin.post('/api/bookings', {
      lead_id: lead.id,
      destination: 'Manali',
      total_amount: 10000,
      services: [{ name: 'Package', amount: 10000 }],
    });
    assert.equal(bookingRes.status, 201, JSON.stringify(bookingRes.body));
    const booking = bookingRes.body.data;
    assert.match(booking.booking_number, /^BK-\d{8}-\d{4}$/);

    const partial = await admin.post(`/api/bookings/${booking.id}/payments`, {
      amount: 4000,
      method: 'UPI',
      reference: 'UPI-1',
    });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.data.booking.payment_status, 'PARTIAL');
    assert.equal(partial.body.data.booking.paid_amount, 4000);

    const rest = await admin.post(`/api/bookings/${booking.id}/payments`, { amount: 6000, method: 'Cash' });
    assert.equal(rest.body.data.booking.payment_status, 'PAID');
    assert.equal(rest.body.data.booking.balance_due, 0);

    const payments = await admin.get(`/api/bookings/${booking.id}/payments`);
    assert.equal(payments.status, 200);
    assert.equal(payments.body.data.length, 2);
  });

  it('follows booking status transitions', async () => {
    const { admin, lead } = await setup();
    const created = await admin.post('/api/bookings', { lead_id: lead.id, total_amount: 500 });
    const id = created.body.data.id;

    const confirmed = await admin.post(`/api/bookings/${id}/status`, { status: 'CONFIRMED' });
    assert.equal(confirmed.status, 200);

    const bad = await admin.post(`/api/bookings/${id}/status`, { status: 'PENDING' });
    assert.equal(bad.status, 409, 'confirmed bookings cannot go back to pending');

    const progress = await admin.post(`/api/bookings/${id}/status`, { status: 'IN_PROGRESS' });
    assert.equal(progress.status, 200);
    const done = await admin.post(`/api/bookings/${id}/status`, { status: 'COMPLETED' });
    assert.equal(done.status, 200);
    const reopen = await admin.post(`/api/bookings/${id}/status`, { status: 'CONFIRMED' });
    assert.equal(reopen.status, 409, 'completed bookings are closed');
  });

  it('keeps worker bookings scoped', async () => {
    const { admin, worker, workerId, lead } = await setup();
    const mine = await worker.post('/api/bookings', { lead_id: lead.id, total_amount: 100 });
    assert.equal(mine.status, 201);

    const adminBooking = await admin.post('/api/bookings', {
      customer_id: (await admin.post('/api/customers', { name: `Priv ${Date.now()}`, phone: `9${Date.now()}` })).body
        .data.id,
      total_amount: 999,
    });
    assert.equal(adminBooking.status, 201);

    const seen = await worker.get(`/api/bookings/${adminBooking.body.data.id}`);
    assert.equal(seen.status, 403);

    const list = await worker.get('/api/bookings');
    assert.ok(list.body.data.every((b: any) => b.worker_id === workerId || b.created_by === workerId));
  });
});
