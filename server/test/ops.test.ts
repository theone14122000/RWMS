import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  baseUrl,
  closeHarness,
  createClient,
  createCustomer,
  createLead,
  createWorkerClient,
} from './helpers/harness.js';

after(closeHarness);

async function adminClient() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  return admin;
}

async function setup() {
  const admin = await adminClient();
  const w = await createWorkerClient(admin);
  const lead = await createLead(admin, { destination: 'Ops Dest' });
  await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: w.id });
  return { admin, worker: w.client, workerId: w.id, lead };
}

function csv(text: string): { header: string[]; rows: string[] } {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  return { header: lines[0]?.split(',') ?? [], rows: lines.slice(1) };
}

async function rawCsv(path: string, cookie: string) {
  const res = await fetch(baseUrl + path, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

describe('reports and CSV exports', () => {
  it('returns a period summary for admins and denies workers', async () => {
    const { admin, worker } = await setup();
    const res = await admin.get('/api/reports/summary?period=month');
    assert.equal(res.status, 200);
    assert.ok(res.body.data, 'summary payload present');

    const denied = await worker.get('/api/reports/summary');
    assert.equal(denied.status, 403);
  });

  it('streams a CSV export with headers and an attachment filename', async () => {
    const { admin, worker } = await setup();
    const res = await rawCsv('/api/reports/exports/leads', admin.cookie!);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const parsed = csv(res.text);
    assert.equal(parsed.header.includes('lead_number'), true);
    assert.equal(parsed.rows.length >= 1, true);

    const denied = await rawCsv('/api/reports/exports/leads', worker.cookie!);
    assert.equal(denied.status, 403);

    const unknown = await rawCsv('/api/reports/exports/nope', admin.cookie!);
    assert.equal(unknown.status, 404);
  });

  it('neutralises spreadsheet formula injection in CSV exports', async () => {
    const { admin } = await setup();
    await createLead(admin, { destination: '=1+1' });

    const res = await rawCsv('/api/reports/exports/leads', admin.cookie!);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("'=1+1"), 'formula cells are prefixed so Excel treats them as text');
    assert.ok(!/(^|\n)=1\+1/.test(res.text), 'raw formula never reaches the CSV unescaped');
  });

  it('previews export data as JSON', async () => {
    const { admin } = await setup();
    const res = await admin.get('/api/reports/exports/customers/preview?limit=5');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.entity, 'customers');
    assert.ok(Array.isArray(res.body.data.header));
    assert.ok(res.body.data.rows.length <= 5);
  });
});

describe('CSV import pipeline', () => {
  const goodPhone = `9${Date.now().toString().slice(-9)}`;
  const csvText = [
    'name,phone,destination,budget',
    `Import Person,${goodPhone},Manali,50000`,
    ',9876543210,Goa,1000',
    `Import Person,${goodPhone},Goa,2000`,
  ].join('\n');

  it('parses an upload into a preview job with row classification', async () => {
    const { admin, worker } = await setup();

    const denied = await worker.post('/api/imports', {
      filename: 'x.csv',
      content_base64: Buffer.from(csvText).toString('base64'),
    });
    assert.equal(denied.status, 403);

    const res = await admin.post('/api/imports', {
      filename: 'leads.csv',
      content_base64: Buffer.from(csvText).toString('base64'),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const job = res.body.data;
    assert.equal(job.status, 'PARSED');
    assert.equal(job.total_rows, 3);
    assert.equal(job.valid_rows, 1);
    assert.equal(job.invalid_rows, 1);
    assert.equal(job.duplicate_rows, 1);

    const detail = await admin.get(`/api/imports/${job.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, job.id);
  });

  it('runs the job, importing valid rows once', async () => {
    const { admin } = await setup();
    const parsed = await admin.post('/api/imports', {
      filename: 'leads-run.csv',
      content_base64: Buffer.from(csvText).toString('base64'),
    });
    const id = parsed.body.data.id;

    const run = await admin.post(`/api/imports/${id}/run`, { assign: 'NONE' });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.data.status, 'COMPLETED');
    assert.equal(run.body.data.imported_rows, 1);
    assert.equal(run.body.data.failed_rows, 1);

    const again = await admin.post(`/api/imports/${id}/run`, { assign: 'NONE' });
    assert.equal(again.status, 409, 'cannot run a completed import twice');

    const list = await admin.get('/api/imports');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((j: any) => j.id === id), true);
  });
});

describe('duplicate detection and merging', () => {
  it('scans idempotently and resolves reviews', async () => {
    const { admin } = await setup();
    const phone = `9${Date.now().toString().slice(-9)}`;
    await createCustomer(admin, { phone, name: 'Dup First' });
    await createCustomer(admin, { phone, name: 'Dup Second', allow_duplicate: true });

    const scan = await admin.post('/api/duplicates/scan');
    assert.equal(scan.status, 201);
    assert.equal(scan.body.data.customers_found, 1);

    const rescan = await admin.post('/api/duplicates/scan');
    assert.equal(rescan.body.data.customers_found, 0, 'scan does not duplicate existing reviews');

    const list = await admin.get('/api/duplicates?status=OPEN');
    assert.equal(list.status, 200);
    const review = list.body.data.find((r: any) => r.entity === 'CUSTOMER');
    assert.ok(review, 'open customer review');

    const keep = await admin.post(`/api/duplicates/${review.id}/decide`, { action: 'KEPT_SEPARATE' });
    assert.equal(keep.status, 200);
    assert.equal(keep.body.data.status, 'KEPT_SEPARATE');

    const again = await admin.post(`/api/duplicates/${review.id}/decide`, { action: 'MERGED' });
    assert.equal(again.status, 409, 'review already decided');
  });

  it('merges duplicate customers and moves their leads to the kept record', async () => {
    const { admin } = await setup();
    const phone = `9${Date.now().toString().slice(-9)}`;
    const a = await createCustomer(admin, { phone, name: 'Merge A' });
    const b = await createCustomer(admin, { phone, name: 'Merge B', allow_duplicate: true });
    const leadB = await createLead(admin, { customer_id: b.id, destination: 'Merge Dest' });

    await admin.post('/api/duplicates/scan');
    const list = await admin.get('/api/duplicates?status=OPEN');
    const review = list.body.data.find(
      (r: any) => r.entity === 'CUSTOMER' && (r.entity_id === b.id || r.candidate_id === b.id),
    );
    assert.ok(review, 'review found for the second customer pair');

    const merge = await admin.post(`/api/duplicates/${review.id}/decide`, { action: 'MERGED' });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    assert.equal(merge.body.data.status, 'MERGED');
    assert.ok(merge.body.data.counts, 'merge counts returned');

    const leadAfter = await admin.get(`/api/leads/${leadB.id}`);
    assert.equal(leadAfter.body.data.customer?.id, a.id, 'lead moved to the kept customer');
  });
});

describe('assignment engine and automation', () => {
  it('auto-assigns new leads once a non-manual strategy is configured', async () => {
    const { admin } = await setup();

    const patch = await admin.patch('/api/meta/settings/assignment', {
      value: { strategy: 'ROUND_ROBIN', auto_assign_new: true, destination_rules: [] },
    });
    assert.equal(patch.status, 200);

    const created = await createLead(admin, { destination: 'Auto Dest' });
    assert.ok(created.assignee, 'round-robin assigned an active worker');
    assert.equal(created.assignee.status, 'ACTIVE');

    await admin.patch('/api/meta/settings/assignment', {
      value: { strategy: 'MANUAL', auto_assign_new: false, destination_rules: [] },
    });
  });

  it('sweeps existing unassigned leads via the automation endpoint', async () => {
    const { admin, worker } = await setup();
    await admin.patch('/api/meta/settings/assignment', {
      value: { strategy: 'MANUAL', auto_assign_new: false, destination_rules: [] },
    });
    const unassigned = await createLead(admin, { destination: 'Sweep Dest' });
    assert.equal(unassigned.assignee, null, 'manual strategy leaves leads unassigned');

    await admin.patch('/api/meta/settings/assignment', {
      value: { strategy: 'WORKLOAD', auto_assign_new: false, destination_rules: [] },
    });

    const sweep = await admin.post('/api/automation/assign', {});
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    assert.ok(sweep.body.data.assigned >= 1);

    const after = await admin.get(`/api/leads/${unassigned.id}`);
    assert.ok(after.body.data.assignee, 'previously unassigned lead now owned');

    const status = await admin.get('/api/automation/status');
    assert.equal(status.status, 200);
    assert.ok(status.body.data.counts);
    assert.equal(status.body.data.assignment.strategy, 'WORKLOAD');

    const run = await admin.post('/api/automation/run', { assign: false });
    assert.equal(run.status, 200);
    assert.ok(run.body.data, 'run report returned');

    const workerDenied = await worker.get('/api/automation/status');
    assert.equal(workerDenied.status, 403);

    await admin.patch('/api/meta/settings/assignment', {
      value: { strategy: 'MANUAL', auto_assign_new: false, destination_rules: [] },
    });
    void worker;
  });
});

describe('AI assistant (unconfigured)', () => {
  it('reports unconfigured status and returns draft-less responses', async () => {
    const { admin, lead } = await setup();

    const status = await admin.get('/api/ai/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.configured, false);
    assert.equal(status.body.data.secret_present, false);

    const summary = await admin.post('/api/ai/summary', { lead_id: lead.id });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.configured, false);
    assert.equal(summary.body.data.draft, null);

    const draft = await admin.post('/api/ai/message-draft', { lead_id: lead.id, goal: 'follow up' });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.data.configured, false);
  });
});

describe('communications', () => {
  it('exposes honest channel status and records unconfigured sends', async () => {
    const { admin, lead } = await setup();

    const channels = await admin.get('/api/communications/channels');
    assert.equal(channels.status, 200);
    assert.equal(channels.body.data.whatsapp.configured, false);
    assert.equal(channels.body.data.in_app.configured, true);

    const send = await admin.post('/api/communications', {
      channel: 'WHATSAPP',
      lead_id: lead.id,
      body: 'Hello from the CRM',
    });
    assert.equal(send.status, 201, JSON.stringify(send.body));
    assert.equal(send.body.data.configured, false);
    assert.equal(send.body.data.reason, 'Integration Not Configured');
    assert.equal(send.body.data.status, 'NOT_CONFIGURED');

    const list = await admin.get(`/api/communications?lead_id=${lead.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length >= 1, true);
  });

  it('delivers in-app messages and notifies the worker', async () => {
    const { admin, worker, workerId, lead } = await setup();
    const send = await admin.post('/api/communications', {
      channel: 'IN_APP',
      lead_id: lead.id,
      worker_id: workerId,
      subject: 'Call this lead',
      body: 'Customer asked for a callback.',
    });
    assert.equal(send.status, 201, JSON.stringify(send.body));
    assert.equal(send.body.data.status, 'SENT');

    const inbox = await worker.get('/api/notifications');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.data.length >= 1, true);
  });
});

describe('documents', () => {
  it('uploads, lists, streams and deletes a lead document with audit-friendly access rules', async () => {
    const { admin, worker, lead } = await setup();

    const upload = await admin.post('/api/documents', {
      entity: 'LEAD',
      entity_id: lead.id,
      category: 'Itinerary',
      filename: 'itinerary.txt',
      mime_type: 'text/plain',
      content_base64: Buffer.from('Day 1: Beach').toString('base64'),
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const doc = upload.body.data;
    assert.equal(doc.filename, 'itinerary.txt');
    assert.equal(doc.entity, 'LEAD');

    const list = await admin.get(`/api/documents?entity=LEAD&entity_id=${lead.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);

    const file = await admin.get(`/api/documents/${doc.id}/file`);
    assert.equal(file.status, 200);

    const workerDelete = await worker.delete(`/api/documents/${doc.id}`);
    assert.equal(workerDelete.status, 403, 'only the uploader or a manager can delete');

    const del = await admin.delete(`/api/documents/${doc.id}`);
    assert.equal(del.status, 200);

    const after = await admin.get(`/api/documents/${doc.id}/file`);
    assert.equal(after.status, 404);
  });
});

describe('analytics and integrations status', () => {
  it('serves aggregate analytics for admins only', async () => {
    const { admin, worker, workerId, lead } = await setup();
    await admin.post('/api/calls', { lead_id: lead.id, status: 'COMPLETED', duration_seconds: 45 });

    const overview = await admin.get('/api/analytics/overview?period=month');
    assert.equal(overview.status, 200);
    assert.ok(overview.body.data);

    const workers = await admin.get('/api/analytics/workers');
    assert.equal(workers.status, 200);
    assert.equal(Array.isArray(workers.body.data.workers), true);
    assert.ok(workers.body.data.workers.length >= 1);

    const detail = await admin.get(`/api/analytics/workers/${workerId}?period=month`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.data.metrics, 'per-worker metrics returned');

    const denied = await worker.get('/api/analytics/overview');
    assert.equal(denied.status, 403);
  });

  it('publishes integration status without leaking secrets', async () => {
    const { admin, worker } = await setup();
    const res = await admin.get('/api/meta/integrations');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.telephony.configured, false);
    assert.ok(typeof res.body.data.telephony.secret_present === 'boolean');
    assert.equal(res.body.data.ai.configured, false);
    assert.ok(res.body.data.assignment.strategy);
    assert.ok(res.body.data.call_policy);

    const raw = JSON.stringify(res.body);
    assert.equal(/Bearer\s+[A-Za-z0-9_\-]{10,}/.test(raw), false, 'no bearer tokens leaked');

    const denied = await worker.get('/api/meta/integrations');
    assert.equal(denied.status, 403);
  });
});
