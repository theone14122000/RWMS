/**
 * Test harness: configures an isolated temporary database, boots the Express
 * app on an ephemeral port and exposes a tiny cookie-aware HTTP client.
 *
 * IMPORTANT: the environment block must run before any src module is loaded,
 * which is why src imports below are dynamic.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.SERVE_CLIENT = 'false';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = '0';

/**
 * Local runs must stay on SQLite even when server/.env defines DATABASE_URL
 * (process.loadEnvFile does not override variables that are already set).
 * TEST_PG=1 opts into PostgreSQL instead, with a throwaway per-process schema
 * so parallel test files never share state.
 */
let testPgSchema: string | null = null;
if (process.env.TEST_PG === '1' && process.env.DATABASE_URL) {
  testPgSchema = `rmws_t_${process.pid}_${Date.now().toString(36)}`;
  const url = new URL(process.env.DATABASE_URL);
  const options = (url.searchParams.get('options') ?? '').trim();
  url.searchParams.set('options', `${options} -c search_path=${testPgSchema}`.trim());
  process.env.DATABASE_URL = url.toString();
} else {
  process.env.DATABASE_URL = '';
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-crm-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'crm.sqlite');

const { migrate } = await import('../../src/db/migrate.js');
const { seed } = await import('../../src/db/seed.js');
const { createApp } = await import('../../src/app.js');
const { closeDatabase } = await import('../../src/db/database.js');
const { todayStr, addDays } = await import('../../src/lib/dates.js');

if (testPgSchema) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
  client.on('error', () => {
    /* proxy resets on an in-use admin client must not crash the run */
  });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${testPgSchema}`);
  await client.end();
}

/** Business-timezone date helpers (Asia/Kolkata by default). */
export const today: string = todayStr();
export const day: (offset: number) => string = (offset) => addDays(todayStr(), offset);

await migrate();
await seed();

const server: http.Server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const address = server.address() as AddressInfo;
export const baseUrl = `http://127.0.0.1:${address.port}`;

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  cookie: string | null;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A logged-out client; `login()` attaches the session cookie to later calls. */
export function createClient() {
  let cookie: string | null = null;

  async function request<T = any>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const method = options.method ?? 'GET';
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body, headers: res.headers, cookie };
  }

  return {
    get cookie() {
      return cookie;
    },
    set cookie(value: string | null) {
      cookie = value;
    },
    request,
    get: <T = any>(path: string, headers?: Record<string, string>) => request<T>(path, { headers }),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>(path, { method: 'POST', body, headers }),
    patch: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>(path, { method: 'PATCH', body, headers }),
    delete: <T = any>(path: string, headers?: Record<string, string>) => request<T>(path, { method: 'DELETE', headers }),
    async login(identifier: string, password: string) {
      const res = await request('/api/auth/login', { method: 'POST', body: { identifier, password } });
      if (res.status !== 200) {
        throw new Error(`login failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res;
    },
    logout() {
      cookie = null;
    },
  };
}

export type Client = ReturnType<typeof createClient>;

export const ADMIN = { email: 'admin@travelcrm.local', password: 'Admin@1234!' };

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function createCustomer(admin: Client, overrides: Record<string, unknown> = {}): Promise<any> {
  const res = await admin.post('/api/customers', {
    name: `Customer ${randomSuffix()}`,
    phone: `9${String(Date.now()).slice(-9)}`,
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`customer create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

export async function createLead(
  admin: Client,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const customerId = (overrides.customer_id as number) ?? (await createCustomer(admin)).id;
  const res = await admin.post('/api/leads', {
    customer_id: customerId,
    destination: 'Goa',
    travel_type: 'DOMESTIC',
    adults: 2,
    children: 0,
    requirements: ['Hotel'],
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`lead create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

/** Creates a fresh worker through the API and returns its id + a logged-in client. */
export async function createWorkerClient(
  admin: Client,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<{ id: number; client: Client; email: string }> {
  const email = overrides.email ?? `worker-${Math.random().toString(36).slice(2, 10)}@test.local`;
  const password = overrides.password ?? 'Worker@1234!';
  const created = await admin.post('/api/users', {
    name: overrides.name ?? 'Test Worker',
    email,
    password,
    role: 'WORKER',
    status: 'ACTIVE',
  });
  if (created.status !== 201) {
    throw new Error(`worker create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const client = createClient();
  await client.login(email, password);
  return { id: created.body.data.id, client, email };
}

export async function closeHarness(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
  if (testPgSchema) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
    client.on('error', () => {
      /* proxy resets on an in-use admin client must not crash the run */
    });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${testPgSchema} CASCADE`);
    await client.end();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
