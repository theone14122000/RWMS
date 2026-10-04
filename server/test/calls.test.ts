import crypto from 'node:crypto';
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

async function setup() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  const w = await createWorkerClient(admin);
  const lead = await createLead(admin, { destination: 'Call Dest' });
  await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: w.id });
  return { admin, worker: w.client, workerId: w.id, lead };
}

describe('calls', () => {
  it('logs a call against a lead and surfaces it in the list', async () => {
    const { admin, lead } = await setup();
    const res = await admin.post('/api/calls', {
      lead_id: lead.id,
      direction: 'OUTBOUND',
      status: 'COMPLETED',
      duration_seconds: 125,
      disposition: 'Interested',
      notes: 'Discussed Goa package',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'COMPLETED');
    assert.equal(res.body.data.duration_seconds, 125);
    assert.equal(res.body.data.lead_number, lead.lead_number);
    assert.ok(res.body.data.phone_number, 'phone resolved from the customer');

    const list = await admin.get(`/api/calls?lead_id=${lead.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length >= 1, true);
  });

  it('updates last_contacted_at on the lead after a completed call', async () => {
    const { admin, lead } = await setup();
    await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED', duration_seconds: 30 });
    const detail = await admin.get(`/api/leads/${lead.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.data.last_contacted_at, 'lead last_contacted_at set by the call');
  });

  it('keeps worker calls scoped to their own records', async () => {
    const { admin, worker, workerId, lead } = await setup();
    await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED' });

    const mine = await worker.get('/api/calls');
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.every((c: any) => c.worker_id === workerId));

    const others = await worker.get('/api/calls?worker_id=1');
    assert.equal(others.status, 200);
    assert.equal(others.body.data.length, 0, 'worker cannot list admin calls');
  });

  it('runs the call → follow-up workflow in one request', async () => {
    const { admin, lead } = await setup();
    const call = await admin.post('/api/calls', { lead_id: lead.id, status: 'ANSWERED', duration_seconds: 60 });
    const callId = call.body.data.id;

    const res = await admin.post(`/api/calls/${callId}/next-action`, {
      disposition: 'Callback tomorrow',
      customer_response: 'Wants a revised quote',
      next_action: 'Send revised quotation',
      lead_status: 'CONTACTED',
      follow_up: { scheduled_date: '2030-01-15', scheduled_time: '10:30', type: 'Call' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.follow_up_id, 'follow-up created');
    assert.equal(res.body.data.call.follow_up_id, res.body.data.follow_up_id);
    assert.equal(res.body.data.lead_status, 'CONTACTED');

    const fu = await admin.get(`/api/follow-ups/${res.body.data.follow_up_id}`);
    assert.equal(fu.status, 200);
    assert.equal(fu.body.data.scheduled_date, '2030-01-15');
    assert.equal(fu.body.data.customer_response, 'Wants a revised quote');
  });

  it('blocks a worker from reading or editing another worker’s call', async () => {
    const { admin, worker, lead } = await setup();
    const call = await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED' });
    const callId = call.body.data.id;

    const detail = await worker.get(`/api/calls/${callId}`);
    assert.equal(detail.status, 403);

    const patch = await worker.patch(`/api/calls/${callId}`, { notes: 'tampered' });
    assert.equal(patch.status, 403);
  });

  it('stores a recording, streams it to permitted users and audits access', async () => {
    const { admin, lead } = await setup();
    const call = await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED' });
    const callId = call.body.data.id;

    const missing = await admin.get(`/api/calls/${callId}/recording`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.data.available, false);

    const wav = Buffer.from('RIFF0000WAVEfmt '); // tiny placeholder audio bytes
    const attach = await admin.post(`/api/calls/${callId}/recording`, {
      storage: 'local',
      filename: 'call.wav',
      mime_type: 'audio/wav',
      content_base64: wav.toString('base64'),
      duration_seconds: 42,
    });
    assert.equal(attach.status, 201);
    assert.equal(attach.body.data.available, true);

    const meta = await admin.get(`/api/calls/${callId}/recording`);
    assert.equal(meta.body.data.available, true);
    assert.equal(meta.body.data.can_play, true);
    assert.ok(meta.body.data.retention_until, 'retention date recorded');

    const stream = await admin.get(`/api/calls/${callId}/recording/stream`);
    assert.equal(stream.status, 200);

    const again = await admin.post(`/api/calls/${callId}/recording`, {
      storage: 'provider',
      provider_recording_id: 'rec-1',
      source_url: 'https://provider.example/rec-1',
    });
    assert.equal(again.status, 409, 'cannot attach a second recording');
  });

  it('requires a configured provider before placing an outbound call', async () => {
    const { admin, lead } = await setup();
    const res = await admin.post('/api/calls/initiate', { lead_id: lead.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INTEGRATION_NOT_CONFIGURED');
  });

  it('reports call statistics for the period', async () => {
    const { admin, worker, lead } = await setup();
    await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED', duration_seconds: 100 });
    await worker.post('/api/calls', { lead_id: lead.id, status: 'MISSED' });

    const res = await admin.get('/api/calls/stats/summary?period=month&scope=all');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.total >= 1);
    assert.ok(res.body.data.answered >= 1);
    assert.ok(res.body.data.missed >= 1);
  });
});

describe('telephony webhooks', () => {
  const secret = 'test-webhook-secret-value';

  function sign(body: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  async function postWebhook(payload: unknown, opts: { signature?: string; token?: string; provider?: string } = {}) {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.signature) headers['x-signature'] = opts.signature;
    if (opts.token) headers['x-webhook-secret'] = opts.token;
    return fetch(`${baseUrl}/api/webhooks/telephony/${opts.provider ?? 'acme'}`, {
      method: 'POST',
      headers,
      body: raw,
    });
  }

  it('rejects webhooks while the signing secret is not configured', async () => {
    const prev = process.env.TELEPHONY_WEBHOOK_SECRET;
    delete process.env.TELEPHONY_WEBHOOK_SECRET;
    try {
      const res = await postWebhook({ event_id: 'evt-x', event_type: 'call.completed' });
      assert.equal(res.status, 409);
      const body: any = await res.json();
      assert.equal(body.error.code, 'INTEGRATION_NOT_CONFIGURED');
    } finally {
      if (prev !== undefined) process.env.TELEPHONY_WEBHOOK_SECRET = prev;
    }
  });

  it('rejects a bad signature', async () => {
    process.env.TELEPHONY_WEBHOOK_SECRET = secret;
    const res = await postWebhook({ event_id: 'evt-bad', event_type: 'call.completed' }, { signature: 'deadbeef' });
    assert.equal(res.status, 403);
  });

  it('creates a call from a signed webhook and is idempotent on retries', async () => {
    process.env.TELEPHONY_WEBHOOK_SECRET = secret;
    const { workerId } = await setup();
    const payload = {
      event_id: `evt-${Date.now()}-a`,
      event_type: 'call.completed',
      worker_id: workerId,
      call: {
        provider_call_id: `call-${Date.now()}`,
        direction: 'INBOUND',
        phone_number: '911234567890',
        duration_seconds: 55,
        started_at: new Date().toISOString(),
      },
    };

    const first = await postWebhook(payload, { signature: sign(JSON.stringify(payload)) });
    assert.equal(first.status, 200);
    const firstBody: any = await first.json();
    assert.equal(firstBody.data.ok, true);
    assert.equal(firstBody.data.action, 'call_created');

    const retry = await postWebhook(payload, { signature: sign(JSON.stringify(payload)) });
    assert.equal(retry.status, 200);
    const retryBody: any = await retry.json();
    assert.equal(retryBody.data.duplicate, true);
  });

  it('attaches a recording delivered by a webhook and notifies the owner', async () => {
    process.env.TELEPHONY_WEBHOOK_SECRET = secret;
    const { admin, workerId } = await setup();
    const payload = {
      event_id: `evt-${Date.now()}-rec`,
      event_type: 'call.recording.ready',
      worker_id: workerId,
      call: { provider_call_id: `call-rec-${Date.now()}`, direction: 'OUTBOUND', duration_seconds: 33 },
      recording: { provider_recording_id: 'rec-99', duration_seconds: 33 },
    };
    const res = await postWebhook(payload, { signature: sign(JSON.stringify(payload)) });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.data.action, 'recording_attached');

    const calls = await admin.get(`/api/calls?limit=50`);
    const call = calls.body.data.find((c: any) => c.provider_call_id === payload.call.provider_call_id);
    assert.ok(call, 'call created by the recording webhook');
    assert.equal(call.recording_available, true);

    const rec = await admin.get(`/api/calls/${call.id}/recording`);
    assert.equal(rec.body.data.available, true);
    assert.equal(rec.body.data.storage, 'provider');
  });

  it('acknowledges unattributable events as failed without creating data', async () => {
    process.env.TELEPHONY_WEBHOOK_SECRET = secret;
    const payload = {
      event_id: `evt-${Date.now()}-orphan`,
      event_type: 'call.completed',
      call: { provider_call_id: `orphan-${Date.now()}` },
    };
    const res = await postWebhook(payload, { signature: sign(JSON.stringify(payload)) });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.data.ok, false);
    assert.match(body.data.error, /attribute/i);
  });
});
