import { Router } from 'express';
import { get } from '../../db/database.js';
import { ok } from '../../lib/http.js';
import { currentUser, requireAuth, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import {
  automationStatus,
  runAutomationOnce,
} from '../../services/scheduler.js';
import { autoAssignPending } from '../../services/assigner.js';
import { assignmentConfig } from '../../services/settings.js';

export const automationRouter = Router();

/**
 * Automation is backend/DB-driven: this router only reports status and lets
 * an admin trigger a pass deterministically (the timer runs the same code).
 */
automationRouter.get('/status', requireAuth, requirePermission('automation:manage'), (_req, res, next) => {
  try {
    const status = automationStatus();
    const counts = {
      unassigned_leads: get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM leads WHERE assigned_to IS NULL AND deleted_at IS NULL',
      )!.c,
      overdue_follow_ups: get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM follow_ups f JOIN leads l ON l.id = f.lead_id
         WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
           AND f.scheduled_date < date('now') AND f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`,
      )!.c,
      expiring_quotations: get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM quotations
         WHERE deleted_at IS NULL AND status IN ('SENT','VIEWED','NEGOTIATION')
           AND valid_until IS NOT NULL AND valid_until < date('now')`,
      )!.c,
      open_duplicate_reviews: get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM duplicate_reviews WHERE status = 'OPEN'`,
      )!.c,
      pending_imports: get<{ c: number }>(`SELECT COUNT(*) AS c FROM import_jobs WHERE status IN ('PARSED')`)!.c,
    };
    ok(res, { ...status, assignment: assignmentConfig(), counts });
  } catch (err) {
    next(err);
  }
});

/** Runs one automation pass immediately (same functions as the scheduler). */
automationRouter.post('/run', requireAuth, requirePermission('automation:manage'), (req, res, next) => {
  try {
    const user = currentUser(req);
    const assign = req.body && typeof req.body === 'object' && (req.body as any).assign === true;

    const ran = runAutomationOnce();
    const assigned = assign ? autoAssignPending({ actorId: user.id, actorName: user.name }) : null;
    audit(req, 'AUTOMATION_RUN', 'automation', null, { ...ran, assigned });

    ok(res, { ran, assigned });
  } catch (err) {
    next(err);
  }
});

/** Applies the assignment strategy to unassigned leads on demand. */
automationRouter.post('/assign', requireAuth, requirePermission('automation:manage'), (req, res, next) => {
  try {
    const user = currentUser(req);
    const result = autoAssignPending({ actorId: user.id, actorName: user.name });
    audit(req, 'AUTO_ASSIGN_RUN', 'lead', null, result);
    ok(res, result);
  } catch (err) {
    next(err);
  }
});
