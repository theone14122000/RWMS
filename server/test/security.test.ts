import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  baseUrl,
  closeHarness,
  createClient,
  createLead,
  createWorkerClient,
} from './helpers/harness.js';

after(closeHarness);

async function adminClient() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  return admin;
}

describe('login lockout', () => {
  it('locks an account after repeated failed logins, even with the correct password', async () => {
    const admin = await adminClient();
    const w = await createWorkerClient(admin);
    const client = createClient();

    for (let i = 0; i < 5; i++) {
      const res = await client.post('/api/auth/login', { identifier: w.email, password: 'WrongPass1!' });
      assert.equal(res.status, 401, `attempt ${i + 1} rejected`);
    }

    const correct = await client.post('/api/auth/login', {
      identifier: w.email,
      password: 'Worker@1234!',
    });
    assert.equal(correct.status, 401, 'locked account rejects the right password too');
    assert.match(correct.body.error.message, /too many failed/i);
  });

  it('never stores the raw identifier in LOGIN_FAILED audit entries', async () => {
    const anon = createClient();
    const res = await anon.post('/api/auth/login', {
      identifier: 'masked.secret@corp.example',
      password: 'nope',
    });
    assert.equal(res.status, 401);

    const admin = await adminClient();
    const audit = await admin.get('/api/audit-logs?action=LOGIN_FAILED&limit=50');
    assert.equal(audit.status, 200);
    const entry = audit.body.data.find(
      (r: any) => typeof r.metadata?.identifier === 'string' && r.metadata.identifier.includes('@corp.example'),
    );
    assert.ok(entry, 'failed login is audited');
    const identifier = entry.metadata.identifier as string;
    assert.equal(identifier, 'ma***@corp.example');
    assert.ok(!JSON.stringify(entry.metadata).includes('masked.secret'), 'raw local part is never stored');
  });
});

describe('password reset', () => {
  it('issues a token to the account owner only, resets once, and blocks reuse', async () => {
    const admin = await adminClient();
    const w = await createWorkerClient(admin);
    const anon = createClient();

    const forgot = await anon.post('/api/auth/password/forgot', { identifier: w.email });
    assert.equal(forgot.status, 200);
    assert.deepEqual(forgot.body.data, { requested: true });

    const unknown = await anon.post('/api/auth/password/forgot', { identifier: 'nobody@nowhere.local' });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.data, { requested: true }, 'response is identical for unknown accounts');

    const notifs = await w.client.get('/api/notifications?limit=20');
    assert.equal(notifs.status, 200);
    const note = notifs.body.data.find((n: any) => n.type === 'PASSWORD_RESET' && n.link);
    assert.ok(note, 'the owner receives the reset link in-app');
    const token = /token=([a-f0-9]{64})/.exec(String(note.link))?.[1];
    assert.ok(token, 'link carries a 256-bit token');

    const reset = await anon.post('/api/auth/password/reset', { token, new_password: 'ResetPass123' });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const oldLogin = await anon.post('/api/auth/login', { identifier: w.email, password: 'Worker@1234!' });
    assert.equal(oldLogin.status, 401, 'old password no longer works');

    const newLogin = await anon.post('/api/auth/login', { identifier: w.email, password: 'ResetPass123' });
    assert.equal(newLogin.status, 200);

    const reuse = await anon.post('/api/auth/password/reset', { token, new_password: 'AnotherPass123' });
    assert.equal(reuse.status, 400, 'token is single-use');
    assert.match(reuse.body.error.message, /invalid or has expired/i);
  });

  it('rejects garbage tokens', async () => {
    const anon = createClient();
    const res = await anon.post('/api/auth/password/reset', {
      token: 'a'.repeat(64),
      new_password: 'Whatever123',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /invalid or has expired/i);
  });
});

describe('upload content sniffing', () => {
  it('accepts a real PDF and rejects a spoofed one', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin);

    const good = await admin.post('/api/documents', {
      entity: 'LEAD',
      entity_id: lead.id,
      filename: 'itinerary.pdf',
      mime_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF').toString('base64'),
    });
    assert.equal(good.status, 201, JSON.stringify(good.body));

    const spoofed = await admin.post('/api/documents', {
      entity: 'LEAD',
      entity_id: lead.id,
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      content_base64: Buffer.from('<script>alert(1)</script>').toString('base64'),
    });
    assert.equal(spoofed.status, 400);
    assert.match(spoofed.body.error.message, /does not match/i);
  });
});

describe('settings exposure', () => {
  it('serves option lists to everyone but hides operational config from workers', async () => {
    const admin = await adminClient();
    const w = await createWorkerClient(admin);

    const workerMeta = await w.client.get('/api/meta');
    assert.equal(workerMeta.status, 200);
    assert.ok(Array.isArray(workerMeta.body.data.options.trip_types), 'workers need form option lists');
    assert.equal(workerMeta.body.data.options.assignment, undefined, 'assignment strategy is not exposed');
    assert.equal(workerMeta.body.data.options.telephony, undefined, 'telephony config is not exposed');
    assert.equal(workerMeta.body.data.options.ai, undefined, 'AI config is not exposed');

    const adminMeta = await admin.get('/api/meta');
    assert.ok(adminMeta.body.data.options.assignment, 'admins keep full settings access');
  });
});

describe('csv export safety', () => {
  it('neutralises spreadsheet formula prefixes in exported values', async () => {
    const admin = await adminClient();
    await createLead(admin, { destination: '=1+2' });

    const res = await fetch(`${baseUrl}/api/reports/exports/leads`, {
      headers: { cookie: admin.cookie ?? '' },
    });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(csv.includes("'=1+2"), 'formula value is prefixed so Excel treats it as text');
  });
});

describe('payment integrity', () => {
  it('caps payments at the outstanding balance and rejects non-positive amounts', async () => {
    const admin = await adminClient();
    const lead = await createLead(admin);
    const quotation = await admin.post('/api/quotations', {
      lead_id: lead.id,
      destination: lead.destination,
      items: [{ description: 'Package', quantity: 1, unit_price: 25000 }],
      inclusions: [],
      exclusions: [],
    });
    assert.equal(quotation.status, 201);
    const qid = quotation.body.data.id;
    await admin.post(`/api/quotations/${qid}/status`, { status: 'SENT' });
    await admin.post(`/api/quotations/${qid}/status`, { status: 'ACCEPTED' });
    const convert = await admin.post(`/api/quotations/${qid}/convert`, {});
    assert.equal(convert.status, 201);
    const bookingId = convert.body.data.booking_id;

    const first = await admin.post(`/api/bookings/${bookingId}/payments`, {
      amount: 10000,
      method: 'Cash',
    });
    assert.equal(first.status < 300, true, JSON.stringify(first.body));

    const overpay = await admin.post(`/api/bookings/${bookingId}/payments`, {
      amount: 20000,
      method: 'Cash',
    });
    assert.equal(overpay.status, 400, 'overpayment is rejected server-side');
    assert.match(overpay.body.error.message, /exceeds the outstanding balance/i);

    const zero = await admin.post(`/api/bookings/${bookingId}/payments`, { amount: 0 });
    assert.equal(zero.status, 400, 'zero payments are rejected');

    const negative = await admin.post(`/api/bookings/${bookingId}/payments`, { amount: -5 });
    assert.equal(negative.status, 400, 'negative payments are rejected');
  });

  it('blocks workers from writing payments to bookings they do not own', async () => {
    const admin = await adminClient();
    const w = await createWorkerClient(admin);
    const lead = await createLead(admin);
    const quotation = await admin.post('/api/quotations', {
      lead_id: lead.id,
      destination: lead.destination,
      items: [{ description: 'Trip', quantity: 1, unit_price: 9000 }],
      inclusions: [],
      exclusions: [],
    });
    const qid = quotation.body.data.id;
    await admin.post(`/api/quotations/${qid}/status`, { status: 'SENT' });
    await admin.post(`/api/quotations/${qid}/status`, { status: 'ACCEPTED' });
    const convert = await admin.post(`/api/quotations/${qid}/convert`, {});
    const bookingId = convert.body.data.booking_id;

    const attempt = await w.client.post(`/api/bookings/${bookingId}/payments`, {
      amount: 100,
      method: 'Cash',
    });
    assert.ok([403, 404].includes(attempt.status), `expected 403/404, got ${attempt.status}`);
  });
});
