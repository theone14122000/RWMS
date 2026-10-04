import { all, get } from '../db/database.js';
import { assignmentConfig, type AssignmentConfig } from './settings.js';
import { nextRoundRobin } from './telephony.js';
import { assignLead, type LeadRow } from '../modules/leads/leads.service.js';

/**
 * Extensible lead assignment engine.
 *
 * Strategies are pluggable: `pickWorker` is the single seam where a new
 * strategy is added. Assignment always goes through `assignLead` so history,
 * timeline entries and notifications stay identical to a manual assignment —
 * the only difference is the recorded reason (`strategy:...`).
 */

interface Candidate {
  id: number;
  name: string;
  open_leads: number;
  skills: string[];
}

function activeWorkers(): Candidate[] {
  const rows = all<{ id: number; name: string; skills: string | null }>(
    `SELECT u.id, u.name, u.skills FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'WORKER' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
     ORDER BY u.id ASC`,
  );
  return rows.map((row) => {
    let skills: string[] = [];
    try {
      const parsed = JSON.parse(row.skills ?? '[]');
      if (Array.isArray(parsed)) skills = parsed.map(String);
    } catch {
      skills = [];
    }
    return { id: row.id, name: row.name, open_leads: openLeadCount(row.id), skills };
  });
}

function openLeadCount(workerId: number): number {
  return (
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN'`,
      [workerId],
    )?.c ?? 0
  );
}

/** Least-loaded ordering used by several strategies (stable tie-break by id). */
function openLeadsSafe(c: Candidate): number {
  return Number.isFinite(c.open_leads) ? c.open_leads : 0;
}

function leastLoaded(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => openLeadsSafe(a) - openLeadsSafe(b) || a.id - b.id);
}

function matchDestinationRule(cfg: AssignmentConfig, destination: string | null): number[] {
  if (!destination) return [];
  const needle = destination.trim().toLowerCase();
  if (!needle) return [];
  for (const rule of cfg.destination_rules ?? []) {
    const pattern = String(rule?.destination ?? '').trim().toLowerCase();
    if (pattern && needle.includes(pattern) && Array.isArray(rule.worker_ids)) {
      const ids = rule.worker_ids.map(Number).filter((n) => Number.isFinite(n));
      if (ids.length) return ids;
    }
  }
  return [];
}

function skillsForLead(lead: Partial<LeadRow>): string[] {
  const out = new Set<string>();
  if (lead.destination) out.add(String(lead.destination).trim().toLowerCase());
  if (lead.trip_type) out.add(String(lead.trip_type).trim().toLowerCase());
  if (lead.travel_type) out.add(String(lead.travel_type).trim().toLowerCase());
  try {
    const reqs = JSON.parse(String(lead.requirements ?? '[]'));
    if (Array.isArray(reqs)) for (const r of reqs) out.add(String(r).trim().toLowerCase());
  } catch {
    /* requirements are free form */
  }
  return [...out].filter(Boolean);
}

/** Pure decision function — returns the chosen worker id (or null). */
export function pickWorker(lead: Partial<LeadRow>, cfg: AssignmentConfig = assignmentConfig()): number | null {
  const workers = activeWorkers();
  if (!workers.length) return null;

  switch (cfg.strategy) {
    case 'ROUND_ROBIN':
      return nextRoundRobin(workers.map((w) => w.id));

    case 'WORKLOAD':
      return leastLoaded(workers)[0]?.id ?? null;

    case 'DESTINATION': {
      const ids = new Set(matchDestinationRule(cfg, lead.destination ?? null));
      const pool = ids.size ? workers.filter((w) => ids.has(w.id)) : workers;
      if (!pool.length) return leastLoaded(workers)[0]?.id ?? null;
      return leastLoaded(pool)[0]?.id ?? null;
    }

    case 'SKILL': {
      const wanted = new Set(skillsForLead(lead));
      const pool = workers.filter((w) => w.skills.some((s) => wanted.has(String(s).trim().toLowerCase())));
      if (!pool.length) return leastLoaded(workers)[0]?.id ?? null;
      return leastLoaded(pool)[0]?.id ?? null;
    }

    case 'MANUAL':
    default:
      return null;
  }
}

export interface AutoAssignResult {
  changed: boolean;
  strategy: string;
  to: number | null;
  reason: string | null;
}

/**
 * Assigns a single unassigned lead using the configured strategy.
 * Never overwrites an existing owner (ownership never changes silently).
 */
export function autoAssignLead(opts: {
  lead: LeadRow;
  actorId: number;
  actorName: string;
  strategy?: string;
}): AutoAssignResult {
  const cfg = assignmentConfig();
  const strategy = opts.strategy ?? cfg.strategy;
  if (strategy === 'MANUAL') return { changed: false, strategy, to: null, reason: null };
  if (opts.lead.assigned_to) return { changed: false, strategy, to: opts.lead.assigned_to, reason: null };

  const picked = pickWorker(opts.lead, { ...cfg, strategy: strategy as AssignmentConfig['strategy'] });
  if (!picked) return { changed: false, strategy, to: null, reason: null };

  const reason = `auto:${strategy.toLowerCase()}`;
  const res = assignLead({
    lead: opts.lead,
    toUserId: picked,
    actorId: opts.actorId,
    actorName: opts.actorName,
    reason,
  });
  return { changed: res.changed, strategy, to: res.to, reason: res.changed ? reason : null };
}

/** Sweeps unassigned leads — used by the automation trigger and tests. */
export function autoAssignPending(opts: { actorId: number; actorName: string }): {
  assigned: number;
  strategy: string;
} {
  const cfg = assignmentConfig();
  if (cfg.strategy === 'MANUAL') return { assigned: 0, strategy: cfg.strategy };
  const rows = all<LeadRow>('SELECT * FROM leads WHERE assigned_to IS NULL AND deleted_at IS NULL ORDER BY id ASC LIMIT 500');
  let assigned = 0;
  for (const lead of rows) {
    try {
      const res = autoAssignLead({ lead, actorId: opts.actorId, actorName: opts.actorName });
      if (res.changed) assigned += 1;
    } catch (err) {
      console.error('[assigner] failed for lead', lead.id, (err as Error).message);
    }
  }
  return { assigned, strategy: cfg.strategy };
}
