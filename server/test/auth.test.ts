import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, closeHarness, createClient, createWorkerClient } from './helpers/harness.js';

after(closeHarness);

describe('authentication & sessions', () => {
  it('health endpoint is public', async () => {
    const client = createClient();
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('rejects API access without a session', async () => {
    const client = createClient();
    const res = await client.get('/api/leads');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  it('logs in the admin with an httpOnly session cookie', async () => {
    const client = createClient();
    const res = await client.login(ADMIN.email, ADMIN.password);
    assert.equal(res.body.data.role, 'ADMIN');
    assert.ok(res.body.data.permissions.includes('leads:assign'));
    assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
  });

  it('exposes the caller profile on /me', async () => {
    const client = createClient();
    await client.login(ADMIN.email, ADMIN.password);
    const res = await client.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.email, ADMIN.email);
    assert.ok(res.body.data.permissions.includes('dashboard:admin'));
    assert.ok(res.body.data.permissions.includes('users:manage'));
  });

  it('supports signing in with a username', async () => {
    const client = createClient();
    const res = await client.login('admin', ADMIN.password);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'ADMIN');
  });

  it('rejects wrong passwords and unknown accounts', async () => {
    const client = createClient();
    const bad = await client.post('/api/auth/login', { identifier: ADMIN.email, password: 'nope' });
    assert.equal(bad.status, 401);
    const unknown = await client.post('/api/auth/login', { identifier: 'ghost@nowhere.local', password: 'x' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'UNAUTHORIZED');
  });

  it('validates the login payload', async () => {
    const client = createClient();
    const res = await client.post('/api/auth/login', {});
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.error.details));
  });

  it('blocks deactivated accounts', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);

    const disabled = await admin.patch(`/api/users/${worker.id}`, { status: 'INACTIVE' });
    assert.equal(disabled.status, 200);

    const login = await createClient().post('/api/auth/login', {
      identifier: worker.email,
      password: 'Worker@1234!',
    });
    assert.equal(login.status, 401);
    assert.match(login.body.error.message, /disabled/i);

    // the existing session stops working as well
    const blocked = await worker.client.get('/api/leads');
    assert.equal(blocked.status, 401);
  });

  it('revokes the session on logout', async () => {
    const client = createClient();
    await client.login(ADMIN.email, ADMIN.password);
    const out = await client.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/i);

    const after = await client.get('/api/auth/me');
    assert.equal(after.status, 401);
  });

  it('revokes all other sessions when the password changes', async () => {
    const admin = createClient();
    await admin.login(ADMIN.email, ADMIN.password);
    const worker = await createWorkerClient(admin);

    const before = await worker.client.get('/api/auth/me');
    assert.equal(before.status, 200);
    const staleCookie = worker.client.cookie;

    const wrongCurrent = await worker.client.patch('/api/auth/password', {
      current_password: 'wrong',
      new_password: 'NewPass123',
    });
    assert.equal(wrongCurrent.status, 400);

    const changed = await worker.client.patch('/api/auth/password', {
      current_password: 'Worker@1234!',
      new_password: 'NewPass123',
    });
    assert.equal(changed.status, 200);

    const stale = createClient();
    stale.cookie = staleCookie;
    const after = await stale.get('/api/auth/me');
    assert.equal(after.status, 401, 'old session must be revoked');

    const fresh = createClient();
    const freshRes = await fresh.get('/api/auth/me');
    assert.equal(freshRes.status, 401, 'no session cookie means no access');

    const relogin = createClient();
    const res = await relogin.login(worker.email, 'NewPass123');
    assert.equal(res.status, 200);
    assert.equal((await relogin.get('/api/auth/me')).status, 200);
  });

  it('rejects weak new passwords', async () => {
    const client = createClient();
    await client.login(ADMIN.email, ADMIN.password);
    const res = await client.patch('/api/auth/password', {
      current_password: ADMIN.password,
      new_password: 'short',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d: any) => d.message.includes('8 characters')));
  });

  it('applies CSRF origin checking to state-changing requests', async () => {
    const client = createClient();
    await client.login(ADMIN.email, ADMIN.password);
    const res = await client.post('/api/customers', { name: 'Origin Probe' }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /origin/i);
  });
});
