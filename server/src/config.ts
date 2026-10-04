import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

try {
  if (fs.existsSync(path.join(SERVER_ROOT, '.env'))) {
    process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
  }
} catch {
  /* env file optional */
}

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

const nodeEnv = str('NODE_ENV', 'development');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: num('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  databasePath: str('DATABASE_PATH', path.join(SERVER_ROOT, 'data', 'crm.sqlite')),
  sessionCookieName: str('SESSION_COOKIE', 'ta_crm_session'),
  sessionTtlDays: num('SESSION_TTL_DAYS', 7),
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', false),
  businessTimezone: str('BUSINESS_TIMEZONE', 'Asia/Kolkata'),
  clientDist: path.join(PROJECT_ROOT, 'client', 'dist'),
  serveClient: bool('SERVE_CLIENT', true),
  rateLimit: {
    windowMs: num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    max: num('RATE_LIMIT_MAX', 600),
    loginMax: num('LOGIN_RATE_LIMIT_MAX', 15),
  },
  seedDemoData: bool('SEED_DEMO_DATA', nodeEnv === 'development'),
  admin: {
    name: str('ADMIN_NAME', 'System Owner'),
    email: str('ADMIN_EMAIL', 'admin@travelcrm.local'),
    password: str('ADMIN_PASSWORD', 'Admin@1234!'),
  },
};
