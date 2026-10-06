import express, { raw, type Express, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { originGuard, sessionLoader } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { leadsRouter } from './modules/leads/leads.routes.js';
import { followUpsRouter } from './modules/followups/followups.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { workloadRouter } from './modules/workload/workload.routes.js';
import { metaRouter } from './modules/meta/meta.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { callsRouter } from './modules/calls/calls.routes.js';
import { telephonyWebhooksRouter } from './modules/calls/webhooks.routes.js';
import { quotationsRouter } from './modules/quotations/quotations.routes.js';
import { bookingsRouter } from './modules/bookings/bookings.routes.js';
import { invoicesRouter } from './modules/invoices/invoices.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { importsRouter } from './modules/imports/imports.routes.js';
import { duplicatesRouter } from './modules/duplicates/duplicates.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { communicationsRouter } from './modules/communications/communications.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { automationRouter } from './modules/automation/automation.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // Webhook deliveries keep their raw bytes so signatures can be verified
  // against the exact body the provider signed; this must run first.
  app.use('/api/webhooks', raw({ type: '*/*', limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Security headers (minimal, dependency-free)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
      ].join('; '),
    );
    if (config.isProduction && (req.secure || config.trustProxy)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(originGuard);
  app.use(sessionLoader);

  // Provider webhooks are mounted before the generic rate limiter: they are
  // authenticated by signature (not cookies) and must not be throttled by the
  // per-user API budget.
  app.use('/api/webhooks', telephonyWebhooksRouter);

  if (!config.isTest) {
    app.use(
      '/api',
      rateLimit({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
      }),
    );
  }

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/follow-ups', followUpsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/quotations', quotationsRouter);
  app.use('/api/bookings', bookingsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/duplicates', duplicatesRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/communications', communicationsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/automation', automationRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/workload', workloadRouter);
  app.use('/api/meta', metaRouter);
  app.use('/api', auditRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use('/api', notFoundHandler);

  if (config.serveClient && fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (req: Request, res: Response, next) => {
      if (req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
