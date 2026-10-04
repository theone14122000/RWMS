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

async function setup() {
  const admin = createClient();
  await admin.login(ADMIN.email, ADMIN.password);
  const worker = await createWorkerClient(admin);
  const lead = await createLead(admin, { destination: 'Follow Up Dest' });
  await admin.post(`/api/leads/${lead.id}/assign`, { worker_id: worker.id });
  return { admin, worker, lead };
}

function column(board: any, key: string) {
  return board.columns.find((c: any) => c.key === key);
}

describe('follow-ups', () => {
  it('exposes exactly six board columns', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const res = await admin.get('/api/follow-ups/board');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.data.columns.map((c: any) => c.key),
      ['PENDING', 'TODAY', 'OVERDUE', 'COMPLETED', 'CONVERTED', 'NOT_INTERESTED'],
    );
    for (const col of res.body.data.columns) {
      assert.equal(col.count >= 0, true);
      assert.ok(Array.isArray(col.items));
    }
  });

  it('schedules a follow-up and buckets it by date', async () => {
    const { worker, lead } = await setup();

    const todayFu = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: today,
      scheduled_time: '10:30',
      type: 'Call',
      notes: 'Confirm travellers count',
    });
    assert.equal(todayFu.status, 201);
    assert.equal(todayFu.body.data.status, 'PENDING');
    assert.equal(todayFu.body.data.effective_status, 'TODAY');
    assert.equal(todayFu.body.data.board_column, 'TODAY');
    assert.equal(todayFu.body.data.worker.id, worker.id);

    const past = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: day(-3),
      type: 'WhatsApp',
    });
    assert.equal(past.status, 201);
    assert.equal(past.body.data.effective_status, 'OVERDUE');
    assert.equal(past.body.data.board_column, 'OVERDUE');

    const future = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: day(4),
      type: 'Email',
    });
    assert.equal(future.body.data.effective_status, 'PENDING');
    assert.equal(future.body.data.board_column, 'PENDING');

    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const board = await admin.get('/api/follow-ups/board');
    assert.ok(column(board.body.data, 'TODAY').items.some((f: any) => f.id === todayFu.body.data.id));
    assert.ok(column(board.body.data, 'OVERDUE').items.some((f: any) => f.id === past.body.data.id));
    assert.ok(column(board.body.data, 'PENDING').items.some((f: any) => f.id === future.body.data.id));
  });

  it('validates scheduling input', async () => {
    const { worker, lead } = await setup();
    const badDate = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: '10/05/2026',
      type: 'Call',
    });
    assert.equal(badDate.status, 400);

    const badTime = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: today,
      scheduled_time: '25:99:00',
      type: 'Call',
    });
    assert.equal(badTime.status, 400);

    const missingLead = await worker.client.post('/api/follow-ups', { lead_id: 9999999, scheduled_date: today });
    assert.equal(missingLead.status, 404);
  });

  it('scopes the board and list to the logged-in worker', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const mine = await createWorkerClient(admin);
    const theirs = await createWorkerClient(admin);

    const myLead = await createLead(admin, { destination: 'Mine' });
    await admin.post(`/api/leads/${myLead.id}/assign`, { worker_id: mine.id });
    const theirLead = await createLead(admin, { destination: 'Theirs' });
    await admin.post(`/api/leads/${theirLead.id}/assign`, { worker_id: theirs.id });

    const myFu = await mine.client.post('/api/follow-ups', { lead_id: myLead.id, scheduled_date: today, type: 'Call' });
    const theirFu = await theirs.client.post('/api/follow-ups', {
      lead_id: theirLead.id,
      scheduled_date: today,
      type: 'Call',
    });

    const myBoard = await mine.client.get('/api/follow-ups/board');
    const ids = myBoard.body.data.columns.flatMap((c: any) => c.items.map((i: any) => i.id));
    assert.ok(ids.includes(myFu.body.data.id));
    assert.ok(!ids.includes(theirFu.body.data.id));

    const myList = await mine.client.get('/api/follow-ups?limit=100');
    assert.ok(myList.body.data.every((f: any) => f.worker.id === mine.id));

    assert.equal((await mine.client.get(`/api/follow-ups/${theirFu.body.data.id}`)).status, 403);
    assert.equal(
      (await mine.client.patch(`/api/follow-ups/${theirFu.body.data.id}`, { status: 'COMPLETED' })).status,
      403,
    );
    assert.equal((await mine.client.delete(`/api/follow-ups/${theirFu.body.data.id}`)).status, 403);
  });

  it('records outcomes and syncs them to the lead pipeline', async () => {
    const { admin, worker, lead } = await setup();

    const converted = await worker.client.post('/api/follow-ups', {
      lead_id: lead.id,
      scheduled_date: day(1),
      type: 'Call',
    });
    const done = await worker.client.patch(`/api/follow-ups/${converted.body.data.id}`, {
      status: 'CONVERTED',
      customer_response: 'Booked the Goa package',
      next_action: 'Send advance invoice',
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'CONVERTED');
    assert.equal(done.body.data.effective_status, 'CONVERTED');
    assert.ok(done.body.data.completed_at);

    const afterConvert = await admin.get(`/api/leads/${lead.id}`);
    assert.equal(afterConvert.body.data.status.code, 'CONVERTED');

    const timeline = await admin.get(`/api/leads/${lead.id}/timeline`);
    const types = timeline.body.data.map((e: any) => e.type);
    assert.ok(types.includes('FOLLOW_UP_COMPLETED'));
    assert.ok(types.includes('STATUS_CHANGED'));
  });

  it('marks leads not interested from a follow-up outcome', async () => {
    const { admin, worker, lead } = await setup();
    const fu = await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: day(2), type: 'Call' });

    const res = await worker.client.patch(`/api/follow-ups/${fu.body.data.id}`, {
      status: 'NOT_INTERESTED',
      customer_response: 'Going with another agent',
    });
    assert.equal(res.status, 200);

    const detail = await admin.get(`/api/leads/${lead.id}`);
    assert.equal(detail.body.data.status.code, 'NOT_INTERESTED');
  });

  it('supports rescheduling which flips the stored status', async () => {
    const { worker, lead } = await setup();
    const fu = await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: today, type: 'Call' });

    const res = await worker.client.patch(`/api/follow-ups/${fu.body.data.id}`, { scheduled_date: day(6) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'RESCHEDULED');
    assert.equal(res.body.data.effective_status, 'RESCHEDULED');
    assert.equal(res.body.data.board_column, 'PENDING');
    assert.equal(res.body.data.scheduled_date, day(6));
  });

  it('completes a follow-up without touching the lead status', async () => {
    const { admin, worker, lead } = await setup();
    const fu = await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: today, type: 'Call' });

    const res = await worker.client.patch(`/api/follow-ups/${fu.body.data.id}`, { status: 'COMPLETED' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'COMPLETED');
    assert.equal(res.body.data.effective_status, 'COMPLETED');

    const detail = await admin.get(`/api/leads/${lead.id}`);
    assert.equal(detail.body.data.status.code, 'ASSIGNED', 'completed follow-ups do not change the lead');
  });

  it('cancels a follow-up through a soft delete', async () => {
    const { worker, lead } = await setup();
    const fu = await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: day(3), type: 'Call' });

    const deleted = await worker.client.delete(`/api/follow-ups/${fu.body.data.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.cancelled, true);

    const list = await worker.client.get('/api/follow-ups?limit=100');
    assert.ok(!list.body.data.some((f: any) => f.id === fu.body.data.id));

    const again = await worker.client.delete(`/api/follow-ups/${fu.body.data.id}`);
    assert.equal(again.status, 404);
  });

  it('filters follow-ups by status, worker and period', async () => {
    const { admin, worker, lead } = await setup();
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: day(-1), type: 'Call' });
    await worker.client.post('/api/follow-ups', { lead_id: lead.id, scheduled_date: day(9), type: 'Email' });

    const overdue = await admin.get('/api/follow-ups?status=OVERDUE&limit=100');
    assert.equal(overdue.status, 200);
    assert.ok(overdue.body.data.every((f: any) => f.effective_status === 'OVERDUE'));

    const byWorker = await admin.get(`/api/follow-ups?worker_id=${worker.id}&limit=100`);
    assert.ok(byWorker.body.data.every((f: any) => f.worker.id === worker.id));

    const byLead = await admin.get(`/api/follow-ups?lead_id=${lead.id}&limit=100`);
    assert.ok(byLead.body.data.every((f: any) => f.lead_id === lead.id));

    const upcoming = await admin.get('/api/follow-ups?date_from=' + day(8) + '&date_to=' + day(10));
    assert.equal(upcoming.status, 200);
    assert.ok(upcoming.body.data.every((f: any) => f.scheduled_date >= day(8)));
  });

  it('lets an admin schedule a follow-up for another worker', async () => {
    const { admin, worker, lead } = await setup();
    const res = await admin.post('/api/follow-ups', {
      lead_id: lead.id,
      worker_id: worker.id,
      scheduled_date: day(2),
      scheduled_time: '15:00',
      type: 'Meeting',
      notes: 'Site visit',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.worker.id, worker.id);

    const notifications = await worker.client.get('/api/notifications');
    assert.equal(notifications.status, 200);
    assert.ok(notifications.body.data.some((n: any) => n.type === 'FOLLOW_UP_ASSIGNED'));
  });
});
