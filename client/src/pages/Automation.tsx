import { useState } from 'react';
import { ApiError, post } from '../api/client';
import { useQuery } from '../lib/useQuery';
import { formatDateTime } from '../lib/format';
import { Badge, ErrorState, TableSkeleton } from '../ui/atoms';
import { useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

export default function Automation() {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'run' | 'assign' | null>(null);
  const { data, loading, error, reload } = useQuery<any>('/api/automation/status');
  const d = data?.data;

  const run = async () => {
    const okConfirm = await confirm({
      title: 'Run automation now?',
      message: 'Sends due/overdue follow-up notifications, expires stale quotations and applies recording retention.',
      confirmLabel: 'Run now',
    });
    if (!okConfirm) return;
    setBusy('run');
    try {
      const res = await post<{ data: any }>('/api/automation/run', { assign: false });
      const r = res.data.ran;
      toast.push(
        'success',
        'Automation pass complete',
        `${r.due_reminders} due · ${r.overdue_reminders} overdue · ${r.quotations_expired} expired`,
      );
      reload();
    } catch (err) {
      toast.push('error', 'Run failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const assignNow = async () => {
    setBusy('assign');
    try {
      const res = await post<{ data: any }>('/api/automation/assign', {});
      if (res.data.strategy === 'MANUAL' && !res.data.assigned) {
        toast.push('error', 'Strategy is MANUAL', 'Switch the assignment strategy in Settings first.');
      } else {
        toast.push('success', 'Assignment sweep complete', `${res.data.assigned} lead(s) assigned · ${res.data.strategy}`);
      }
      reload();
    } catch (err) {
      toast.push('error', 'Assignment failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="card"><TableSkeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><ErrorState message={error ?? 'No status'} onRetry={reload} /></div>;

  const counts = d.counts ?? {};
  const countCards: Array<{ key: string; label: string; danger?: boolean }> = [
    { key: 'unassigned_leads', label: 'Unassigned leads' },
    { key: 'overdue_follow_ups', label: 'Overdue follow-ups', danger: true },
    { key: 'expiring_quotations', label: 'Expired quotations' },
    { key: 'open_duplicate_reviews', label: 'Open duplicate reviews' },
    { key: 'pending_imports', label: 'Pending imports' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automation</h1>
          <div className="sub">
            Reminder notifications, quotation expiry, recording retention and lead assignment — backend driven, triggerable here.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={assignNow}>
            {busy === 'assign' ? 'Assigning…' : 'Run assignment sweep'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={run}>
            {busy === 'run' ? 'Running…' : 'Run automation now'}
          </button>
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        {countCards.map((c) => (
          <div key={c.key} className={`kpi${counts[c.key] > 0 && c.danger ? ' accent-red' : ''}`}>
            <div className="label">{c.label}</div>
            <div className="value">{counts[c.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className={`kpi${d.scheduler_enabled ? ' accent-green' : ''}`}>
          <div className="label">Scheduler</div>
          <div className="value" style={{ fontSize: 17 }}>{d.scheduler_enabled ? 'Running' : 'Stopped'}</div>
        </div>
        <div className={`kpi${d.reminders?.enabled ? '' : ' accent-amber'}`}>
          <div className="label">Due reminders</div>
          <div className="value" style={{ fontSize: 17 }}>{d.reminders?.enabled ? 'Enabled' : 'Disabled'}</div>
        </div>
        <div className={`kpi${d.reminders?.overdue_enabled ? '' : ' accent-amber'}`}>
          <div className="label">Overdue reminders</div>
          <div className="value" style={{ fontSize: 17 }}>{d.reminders?.overdue_enabled ? 'Enabled' : 'Disabled'}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Assignment</h3>
        </div>
        <div className="card-body stack" style={{ gap: 8 }}>
          <div className="row small">
            <span className="muted" style={{ width: 160 }}>Strategy</span>
            <Badge color={d.assignment?.strategy === 'MANUAL' ? 'gray' : 'blue'}>{d.assignment?.strategy}</Badge>
            <span className="muted">
              {d.assignment?.strategy === 'MANUAL'
                ? 'New leads stay unassigned until you assign them.'
                : d.assignment?.strategy === 'DESTINATION'
                  ? 'Leads route by destination rules.'
                  : 'Leads route to the least-loaded worker.'}
            </span>
          </div>
          <div className="row small">
            <span className="muted" style={{ width: 160 }}>Auto-assign new leads</span>
            <Badge color={d.assignment?.auto_assign_new ? 'green' : 'outline'}>{d.assignment?.auto_assign_new ? 'ON' : 'OFF'}</Badge>
            <span className="muted">Applies when a lead is created (web form / CSV import / manual).</span>
          </div>
          <div className="row small">
            <span className="muted" style={{ width: 160 }}>Destination rules</span>
            <span>{d.assignment?.destination_rules?.length ?? 0} rule(s)</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Last run</h3>
        </div>
        <div className="card-body">
          {!d.last_run ? (
            <div className="small muted">The scheduler has not run yet in this environment.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ran at</th>
                    <th className="text-right">Due reminders</th>
                    <th className="text-right">Overdue reminders</th>
                    <th className="text-right">Quotations expired</th>
                    <th className="text-right hide-sm">Recordings expired</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono small">{formatDateTime(d.last_run.ran_at)}</td>
                    <td className="text-right">{d.last_run.due_reminders ?? 0}</td>
                    <td className="text-right">{d.last_run.overdue_reminders ?? 0}</td>
                    <td className="text-right">{d.last_run.quotations_expired ?? 0}</td>
                    <td className="text-right hide-sm">{d.last_run.recordings_expired ?? 0}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
