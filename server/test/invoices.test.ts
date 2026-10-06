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

async function setup() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  const w = await createWorkerClient(admin);
  return { admin, worker: w.client, workerId: w.id, email: w.email };
}

async function makeBooking(admin: any) {
  const lead = await createLead(admin);
  const quotation = await admin.post('/api/quotations', {
    lead_id: lead.id,
    destination: lead.destination,
    items: [{ description: 'Package', quantity: 1, unit_price: 25000 }],
    inclusions: [],
    exclusions: [],
  });
  assert.equal(quotation.status, 201, JSON.stringify(quotation.body));
  const qid = quotation.body.data.id;
  await admin.post(`/api/quotations/${qid}/status`, { status: 'SENT' });
  await admin.post(`/api/quotations/${qid}/status`, { status: 'ACCEPTED' });
  const convert = await admin.post(`/api/quotations/${qid}/convert`, {});
  assert.equal(convert.status, 201, JSON.stringify(convert.body));
  const booking = await admin.get(`/api/bookings/${convert.body.data.booking_id}`);
  return booking.body.data;
}

describe('invoices', () => {
  it('creates an invoice with server-computed subtotal, tax and totals', async () => {
    const { admin } = await setup();
    const customer = await createCustomer(admin);

    const res = await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [
        { description: 'Package', qty: 2, unit_price: 5000 },
        { description: 'Guide', qty: 1, unit_price: 1500 },
      ],
      tax_rate: 18,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const inv = res.body.data;
    assert.match(inv.invoice_number, /^INV-\d{8}-\d{4}$/);
    assert.equal(inv.subtotal, 11500, 'subtotal is qty x unit_price summed server-side');
    assert.equal(inv.tax_amount, 2070, 'tax is computed server-side');
    assert.equal(inv.total_amount, 13570);
    assert.equal(inv.paid_amount, 0);
    assert.equal(inv.status, 'DRAFT');
    assert.equal(inv.customer_name, customer.name);
  });

  it('ignores client-supplied totals', async () => {
    const { admin } = await setup();
    const customer = await createCustomer(admin);

    const res = await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Transfer', qty: 1, unit_price: 4000 }],
      total_amount: 1,
      subtotal: 1,
      tax_amount: 0,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.total_amount, 4000, 'money math never comes from the client');
    assert.equal(res.body.data.subtotal, 4000);
  });

  it('walks valid status transitions and rejects invalid ones', async () => {
    const { admin } = await setup();
    const customer = await createCustomer(admin);
    const created = await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Trip', qty: 1, unit_price: 10000 }],
    });
    const id = created.body.data.invoice_id ?? created.body.data.id;

    const skipToPaid = await admin.patch(`/api/invoices/${id}/status`, { status: 'PAID' });
    assert.equal(skipToPaid.status, 409, 'DRAFT cannot jump to PAID');

    const issued = await admin.patch(`/api/invoices/${id}/status`, { status: 'ISSUED' });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));

    const paid = await admin.patch(`/api/invoices/${id}/status`, { status: 'PAID' });
    assert.equal(paid.status, 200);

    const back = await admin.patch(`/api/invoices/${id}/status`, { status: 'DRAFT' });
    assert.equal(back.status, 409, 'PAID cannot go back to DRAFT');

    const voided = await admin.patch(`/api/invoices/${id}/status`, { status: 'VOID' });
    assert.equal(voided.status, 200);
  });

  it('scopes invoices for workers to their own records', async () => {
    const { admin, worker } = await setup();
    const customer = await createCustomer(admin);
    const mine = await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Admin invoice', qty: 1, unit_price: 7000 }],
    });
    const myId = mine.body.data.invoice_id ?? mine.body.data.id;

    const list = await worker.get('/api/invoices');
    assert.equal(list.status, 200);
    const visible = (list.body.data as any[]).map((i) => i.id);
    assert.ok(!visible.includes(myId), "another worker's invoice is not listed");

    const detail = await worker.get(`/api/invoices/${myId}`);
    assert.equal(detail.status, 404, 'another worker cannot open the invoice');

    const create = await worker.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Worker invoice', qty: 1, unit_price: 500 }],
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const workerInvId = create.body.data.invoice_id ?? create.body.data.id;

    const workerList = await worker.get('/api/invoices');
    assert.ok((workerList.body.data as any[]).some((i) => i.id === workerInvId), 'own invoice is visible');

    const adminList = await admin.get('/api/invoices');
    assert.equal(adminList.status, 200);
    assert.ok((adminList.body.data as any[]).some((i) => i.id === myId), 'admin sees everything');
  });

  it('edits only draft invoices and lets only managers delete', async () => {
    const { admin, worker } = await setup();
    const customer = await createCustomer(admin);
    const created = await worker.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Editable', qty: 1, unit_price: 3000 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.invoice_id ?? created.body.data.id;

    const edit = await worker.patch(`/api/invoices/${id}`, {
      items: [{ description: 'Edited', qty: 2, unit_price: 3500 }],
      tax_rate: 10,
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.data.subtotal, 7000, 'totals recomputed on edit');
    assert.equal(edit.body.data.tax_amount, 700);
    assert.equal(edit.body.data.total_amount, 7700);

    await worker.patch(`/api/invoices/${id}/status`, { status: 'ISSUED' });
    const afterIssue = await worker.patch(`/api/invoices/${id}`, { notes: 'too late' });
    assert.equal(afterIssue.status, 409, 'issued invoices are locked');

    const workerDelete = await worker.delete(`/api/invoices/${id}`);
    assert.equal(workerDelete.status, 403, 'only invoices:manage can delete');

    const adminDelete = await admin.delete(`/api/invoices/${id}`);
    assert.equal(adminDelete.status, 200);

    const gone = await admin.get(`/api/invoices/${id}`);
    assert.equal(gone.status, 404);
  });

  it('derives paid amount from linked booking payments', async () => {
    const { admin } = await setup();
    const booking = await makeBooking(admin);

    const payment = await admin.post(`/api/bookings/${booking.id}/payments`, {
      amount: 10000,
      method: 'UPI',
    });
    assert.equal(payment.status < 300, true, JSON.stringify(payment.body));

    const created = await admin.post('/api/invoices', {
      customer_id: booking.customer_id,
      booking_id: booking.id,
      items: [{ description: 'Full trip', qty: 1, unit_price: 25000 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const inv = created.body.data;
    assert.equal(inv.currency, booking.currency, 'currency comes from the booking');
    assert.equal(inv.total_amount, 25000);
    assert.equal(inv.paid_amount, 10000, 'paid amount mirrors booking payments');
    assert.equal(inv.balance_due, 15000);

    const detail = await admin.get(`/api/invoices/${inv.invoice_id ?? inv.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.paid_amount, 10000);
  });

  it('totals are aggregated across the whole filtered set, not just the page', async () => {
    const { admin } = await setup();
    const customer = await createCustomer(admin);
    await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'One', qty: 1, unit_price: 1000 }],
    });
    await admin.post('/api/invoices', {
      customer_id: customer.id,
      items: [{ description: 'Two', qty: 1, unit_price: 2500 }],
    });

    const res = await admin.get('/api/invoices?limit=1');
    assert.equal(res.status, 200);
    const totals = res.body.meta.totals;
    assert.ok(totals.count >= 2);
    assert.ok(totals.total_amount >= 3500, `expected aggregate totals, got ${JSON.stringify(totals)}`);
    assert.equal(res.body.data.length, 1, 'page size respected');
  });
});
