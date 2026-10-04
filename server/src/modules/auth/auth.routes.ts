import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { all, get, nowISO, run } from '../../db/database.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { meta, ok } from '../../lib/http.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import {
  clearSessionCookie,
  createSession,
  currentUser,
  requireAuth,
  revokeSession,
  revokeAllSessions,
  setSessionCookie,
} from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';

export const authRouter = Router();

/** Brute-force protection for the login endpoint (disabled under test). */
const loginGuards: RequestHandler[] = config.isTest
  ? []
  : [
      rateLimit({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.loginMax,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: false,
        message: {
          error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' },
        },
      }),
    ];

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or username is required').max(200),
  password: z.string().min(1, 'Password is required').max(200),
});

const passwordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required').max(200),
  new_password: z
    .string()
    .min(8, 'New password must be at least 8 characters')
    .max(200)
    .regex(/[A-Za-z]/, 'Must contain a letter')
    .regex(/[0-9]/, 'Must contain a number'),
});

interface UserAuthRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  username: string | null;
  password_hash: string;
  status: string;
  role_id: number;
  role_code: string;
  created_at: string;
}

function publicUser(user: UserAuthRow, permissions: string[]) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    username: user.username,
    role: user.role_code,
    status: user.status,
    created_at: user.created_at,
    permissions,
  };
}

authRouter.post('/login', ...loginGuards, (req, res, next) => {
  try {
    const body = meta(loginSchema, req.body);
    const identifier = body.identifier.toLowerCase();

    const user = get<UserAuthRow>(
      `SELECT u.id, u.name, u.email, u.phone, u.username, u.password_hash, u.status, u.role_id, u.created_at,
              r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE (lower(u.email) = ? OR lower(u.username) = ?) AND u.deleted_at IS NULL`,
      [identifier, identifier],
    );

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      audit(req, 'LOGIN_FAILED', 'user', user?.id ?? null, { identifier });
      throw unauthorized('Invalid email/username or password.');
    }

    if (user.status !== 'ACTIVE') {
      audit(req, 'LOGIN_BLOCKED', 'user', user.id, { status: user.status });
      throw unauthorized('This account has been disabled. Contact the administrator.');
    }

    const permissions = all<{ code: string }>(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [user.role_id],
    ).map((r) => r.code);

    const { token } = createSession(user.id, req);
    setSessionCookie(res, token);
    run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [nowISO(), nowISO(), user.id]);
    audit(req, 'LOGIN_SUCCESS', 'user', user.id, { role: user.role_code });

    ok(res, publicUser(user, permissions));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res, next) => {
  try {
    const cookies = (req.headers.cookie ?? '').split(';').map((s) => s.trim());
    const raw = cookies.find((c) => c.startsWith(`${config.sessionCookieName}=`));
    if (raw) revokeSession(decodeURIComponent(raw.slice(config.sessionCookieName.length + 1)));
    clearSessionCookie(res);
    if (req.user) audit(req, 'LOGOUT', 'user', req.user.id, {});
    ok(res, { logged_out: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    ok(res, user);
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/password', requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = meta(passwordSchema, req.body);
    const row = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [user.id]);
    if (!row || !verifyPassword(body.current_password, row.password_hash)) {
      throw badRequest('Current password is incorrect.');
    }
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(body.new_password),
      nowISO(),
      user.id,
    ]);
    revokeAllSessions(user.id);
    const { token } = createSession(user.id, req);
    setSessionCookie(res, token);
    audit(req, 'PASSWORD_CHANGED', 'user', user.id, {});
    ok(res, { updated: true });
  } catch (err) {
    next(err);
  }
});
