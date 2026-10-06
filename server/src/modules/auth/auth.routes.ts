import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
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
import { notify } from '../../services/notify.js';
import { sendCommunication } from '../../services/communications.js';

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

const newPasswordField = z
  .string()
  .min(8, 'New password must be at least 8 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/[0-9]/, 'Must contain a number');

const passwordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required').max(200),
  new_password: newPasswordField,
});

const forgotSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or username is required').max(200),
});

const resetSchema = z.object({
  token: z.string().trim().min(16, 'Reset link is invalid').max(200),
  new_password: newPasswordField,
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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
  failed_login_count: number;
  locked_until: string | null;
}

/** Never store or display raw identifiers in audit logs. */
function maskIdentifier(value: string): string {
  const s = String(value ?? '');
  if (s.length <= 2) return '***';
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, 2)}***${s.slice(at)}`;
  return `${s.slice(0, 2)}***`;
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

authRouter.post('/login', ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(loginSchema, req.body);
    const identifier = body.identifier.toLowerCase();
    const masked = maskIdentifier(identifier);

    const user = await get<UserAuthRow>(
      `SELECT u.id, u.name, u.email, u.phone, u.username, u.password_hash, u.status, u.role_id, u.created_at,
              u.failed_login_count, u.locked_until,
              r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE (lower(u.email) = ? OR lower(u.username) = ?) AND u.deleted_at IS NULL`,
      [identifier, identifier],
    );

    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await audit(req, 'LOGIN_LOCKED_OUT', 'user', user.id, { locked_until: user.locked_until });
      throw unauthorized('Too many failed login attempts. Please try again later.');
    }

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      if (user) {
        const attempts = (user.failed_login_count ?? 0) + 1;
        const lock = attempts >= config.loginLockout.maxAttempts;
        await run(
          'UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
          [
            attempts,
            lock ? new Date(Date.now() + config.loginLockout.minutes * 60_000).toISOString() : user.locked_until,
            await nowISO(),
            user.id,
          ],
        );
        await audit(req, 'LOGIN_FAILED', 'user', user.id, {
          identifier: masked,
          attempts,
          locked: lock,
        });
      } else {
        await audit(req, 'LOGIN_FAILED', 'user', null, { identifier: masked });
      }
      throw unauthorized('Invalid email/username or password.');
    }

    if (user.status !== 'ACTIVE') {
      await audit(req, 'LOGIN_BLOCKED', 'user', user.id, { status: user.status });
      throw unauthorized('This account has been disabled. Contact the administrator.');
    }

    const permissions = (await all<{ code: string }>(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [user.role_id],
    )).map((r) => r.code);

    const { token } = await createSession(user.id, req);
    setSessionCookie(res, token);
    await run(
      'UPDATE users SET last_login_at = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      [await nowISO(), await nowISO(), user.id],
    );
    await audit(req, 'LOGIN_SUCCESS', 'user', user.id, { role: user.role_code });

    ok(res, publicUser(user, permissions));
  } catch (err) {
    next(err);
  }
});

/**
 * Starts a password reset. The response is identical whether or not the
 * account exists (no enumeration). The raw token goes only to the account
 * owner: in-app notification + email when a provider is configured — the API
 * never returns it.
 */
authRouter.post('/password/forgot', ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(forgotSchema, req.body);
    const identifier = body.identifier.toLowerCase();

    const user = await get<{ id: number; email: string; name: string }>(
      `SELECT id, email, name FROM users
       WHERE (lower(email) = ? OR lower(username) = ?) AND deleted_at IS NULL AND status = 'ACTIVE'`,
      [identifier, identifier],
    );

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60_000).toISOString();
      await run(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, sha256(token), expiresAt, req.ip ?? null, await nowISO()],
      );
      const origin = `${req.protocol}://${req.get('host') ?? ''}`;
      const link = `${origin}/reset-password?token=${token}`;
      const minutes = config.passwordResetTtlMinutes;
      await sendCommunication({
        channel: 'EMAIL',
        recipient: user.email,
        subject: 'Reset your CRM password',
        body: `A password reset was requested for your account. The link is valid for ${minutes} minutes:\n\n${link}\n\nIf you did not request this, you can ignore this message.`,
        workerId: user.id,
      });
      await notify({
        userId: user.id,
        type: 'PASSWORD_RESET',
        title: 'Password reset requested',
        body: `A reset link was created. It is valid for ${minutes} minutes.`,
        link: `/reset-password?token=${token}`,
      });
      await audit(req, 'PASSWORD_RESET_REQUESTED', 'user', user.id, {});
    } else {
      await audit(req, 'PASSWORD_RESET_REQUESTED', 'user', null, { known: false });
    }

    ok(res, { requested: true });
  } catch (err) {
    next(err);
  }
});

/** Consumes a reset token: sets the new password and signs out every session. */
authRouter.post('/password/reset', ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(resetSchema, req.body);
    const row = await get<{ id: number; user_id: number; expires_at: string; used_at: string | null }>(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
      [sha256(body.token)],
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw badRequest('This reset link is invalid or has expired.');
    }

    const now = await nowISO();
    await run('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?', [now, row.id]);
    await run('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [
      hashPassword(body.new_password),
      now,
      row.user_id,
    ]);
    await revokeAllSessions(row.user_id);
    await audit(req, 'PASSWORD_RESET_COMPLETED', 'user', row.user_id, {});
    await notify({
      userId: row.user_id,
      type: 'PASSWORD_RESET',
      title: 'Password was reset',
      body: 'Your password was changed and all sessions were signed out. If this was not you, contact the administrator.',
    });

    ok(res, { reset: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const cookies = (req.headers.cookie ?? '').split(';').map((s) => s.trim());
    const raw = cookies.find((c) => c.startsWith(`${config.sessionCookieName}=`));
    if (raw) await revokeSession(decodeURIComponent(raw.slice(config.sessionCookieName.length + 1)));
    clearSessionCookie(res);
    if (req.user) await audit(req, 'LOGOUT', 'user', req.user.id, {});
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

authRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = meta(passwordSchema, req.body);
    const row = await get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [user.id]);
    if (!row || !verifyPassword(body.current_password, row.password_hash)) {
      throw badRequest('Current password is incorrect.');
    }
    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(body.new_password),
      await nowISO(),
      user.id,
    ]);
    await revokeAllSessions(user.id);
    const { token } = await createSession(user.id, req);
    setSessionCookie(res, token);
    await audit(req, 'PASSWORD_CHANGED', 'user', user.id, {});
    ok(res, { updated: true });
  } catch (err) {
    next(err);
  }
});
