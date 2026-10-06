import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve the server package root by walking up to the nearest package.json.
// Works from src (tsx dev/test) and from dist/src (compiled), where a naive
// `..` would point at server/dist and break .env loading, data/ and client/dist.
function findServerRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      // server/src/package.json only exists to mark the deployed function
      // bundle (/var/task/src/*.js) as ESM — it is not the server root.
      let skip = false;
      try {
        skip = Boolean(JSON.parse(fs.readFileSync(pj, 'utf8'))?.crmRootSkip);
      } catch {
        skip = false;
      }
      if (!skip) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, '..');
    dir = parent;
  }
}
export const SERVER_ROOT = findServerRoot(here);
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

// Express "trust proxy" as a hop count (0 = disabled): express-rate-limit
// rejects a literal `true` (ERR_ERL_PERMISSIVE_TRUST_PROXY) while a number of
// trusted hops is the correct setting behind Vercel's proxy.
function hops(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  const s = v.toLowerCase();
  return s === 'true' || s === 'yes' ? 1 : 0;
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

// Fail fast on a well-known default admin password in production: any deploy
// without an explicit ADMIN_PASSWORD would otherwise seed a known-credential admin.
const adminPassword = process.env.ADMIN_PASSWORD?.trim();
if (isProduction && !adminPassword) {
  throw new Error(
    '[crm] ADMIN_PASSWORD is required in production. Set it in the environment before starting the server.',
  );
}

export const config = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: num('PORT', 4000),
  host: str('HOST', '0.0.0.0'),
  databasePath: str('DATABASE_PATH', path.join(SERVER_ROOT, 'data', 'crm.sqlite')),
  // Database connection string. `mysql://…` uses MySQL, `postgres://…` uses
  // PostgreSQL (production / Railway); empty falls back to the local SQLite
  // file (dev/tests).
  databaseUrl: str('DATABASE_URL', ''),
  pgPoolMax: num('PG_POOL_MAX', 10),
  sessionCookieName: str('SESSION_COOKIE', 'ta_crm_session'),
  sessionTtlDays: num('SESSION_TTL_DAYS', 7),
  sessionAbsoluteTtlDays: num('SESSION_ABSOLUTE_TTL_DAYS', 30),
  cookieSecure: bool('COOKIE_SECURE', isProduction),
  trustProxy: hops('TRUST_PROXY', 0),
  businessTimezone: str('BUSINESS_TIMEZONE', 'Asia/Kolkata'),
  clientDist: path.join(PROJECT_ROOT, 'client', 'dist'),
  serveClient: bool('SERVE_CLIENT', true),
  rateLimit: {
    windowMs: num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    max: num('RATE_LIMIT_MAX', 600),
    loginMax: num('LOGIN_RATE_LIMIT_MAX', 15),
  },
  loginLockout: {
    maxAttempts: num('LOGIN_LOCKOUT_MAX_ATTEMPTS', 5),
    minutes: num('LOGIN_LOCKOUT_MINUTES', 15),
  },
  passwordResetTtlMinutes: num('PASSWORD_RESET_TTL_MINUTES', 30),
  admin: {
    name: str('ADMIN_NAME', 'System Owner'),
    email: str('ADMIN_EMAIL', 'admin@travelcrm.local'),
    password: adminPassword || str('ADMIN_PASSWORD', 'Admin@1234!'),
  },
};
