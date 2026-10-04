import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, post, qs, type ListResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMeta } from '../lib/meta';
import { useQuery } from '../lib/useQuery';
import { formatDateTime } from '../lib/format';
import {
  Badge,
  EmptyState,
  ErrorState,
  Field,
  Pagination,
  TableSkeleton,
} from '../ui/atoms';
import { Drawer, Modal } from '../ui/overlays';
import { LeadPicker } from '../ui/pickers';
import { useToast } from '../ui/Toast';

const CALL_STATUSES = ['RINGING', 'ANSWERED', 'MISSED', 'BUSY', 'FAILED', 'NO_ANSWER', 'COMPLETED'];
const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];

function durationLabel(seconds?: number | null): string {
  if (!seconds && seconds !== 0) return '—';
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r.toString().padStart(2, '0')}s` : `${r}s`;
}

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'cyan'> = {
  COMPLETED: 'green',
  ANSWERED: 'green',
  MISSED: 'red',
  FAILED: 'red',
  NO_ANSWER: 'red',
  BUSY: 'amber',
  RINGING: 'cyan',
};

export default function Calls() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [direction, setDirection] = useState('');
  const [period, setPeriod] = useState('30d');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [nextOpen, setNextOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [kpiPeriod, setKpiPeriod] = useState<'today' | 'month'>('today');
  const statsScope = can('calls:read_all') ? '&scope=all' : '';
  const { data: stats, reload: reloadStats } = useQuery<any>(`/api/calls/stats/summary?period=${kpiPeriod}${statsScope}`, [reloadKey]);

  const listQs = qs({ page, limit, search, status, direction, period });
  const { data, loading, error, reload } = useQuery<ListResponse<any>>(`/api/calls${listQs}`, [reloadKey]);
  const calls = data?.data ?? [];
  const meta = data?.meta;

  const { data: detail, reload: reloadDetail } = useQuery<any>(selectedId ? `/api/calls/${selectedId}` : null, [reloadKey]);
  const { data: recording, reload: reloadRecording } = useQuery<any>(
    selectedId ? `/api/calls/${selectedId}/recording` : null,
    [reloadKey],
  );

  const reloadAll = () => {
    setReloadKey((k) => k + 1);
    reload();
    reloadStats();
  };

  const s = stats?.data;
  const avgConnected = s && s.connected > 0 ? Math.round((s.total_seconds ?? 0) / s.connected) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calls</h1>
          <div className="sub">Call history, recordings and the follow-up workflow — scoped to your access.</div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setLogOpen(true)} disabled={!can('calls:create')}>
            + Log call
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi accent-cyan">
          <div className="label">Calls · {kpiPeriod === 'today' ? 'today' : 'this month'}</div>
          <div className="value">{s?.total ?? 0}</div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto', fontSize: 11 }} onClick={() => setKpiPeriod(kpiPeriod === 'today' ? 'month' : 'today')}>
            {kpiPeriod === 'today' ? 'Show month' : 'Show today'}
          </button>
        </div>
        <div className="kpi accent-green">
          <div className="label">Connected</div>
          <div className="value">{s?.connected ?? 0}</div>
        </div>
        <div className={`kpi${(s?.missed ?? 0) > 0 ? ' accent-red' : ''}`}>
          <div className="label">Missed</div>
          <div className="value">{s?.missed ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="label">Failed</div>
          <div className="value">{s?.failed ?? 0}</div>
        </div>
        <div className="kpi accent-amber">
          <div className="label">Talk time</div>
          <div className="value" style={{ fontSize: 20 }}>{durationLabel(s?.total_seconds ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="label">Avg / connected</div>
          <div className="value" style={{ fontSize: 20 }}>{durationLabel(avgConnected)}</div>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Search number, lead, customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {CALL_STATUSES.map((c) => (
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select className="select" value={direction} onChange={(e) => { setDirection(e.target.value); setPage(1); }}>
          <option value="">Both directions</option>
          <option value="OUTBOUND">Outbound</option>
          <option value="INBOUND">Inbound</option>
        </select>
        <select className="select" value={period} onChange={(e) => { setPeriod(e.target.value); setPage(1); }}>
          <option value="">All time</option>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !calls.length ? (
          <EmptyState
            title="No calls found"
            description="Log a call or adjust the filters. Webhook-delivered provider calls appear here too."
            action={
              can('calls:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setLogOpen(true)}>
                  + Log call
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Lead</th>
                    <th>Customer</th>
                    <th>Direction</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th className="text-right">Duration</th>
                    <th className="hide-sm">Disposition</th>
                    <th>Rec</th>
                    <th className="actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => setSelectedId(c.id)}>
                      <td className="small nowrap">{formatDateTime(c.started_at ?? c.created_at)}</td>
                      <td>
                        {c.lead_id ? (
                          <Link to={`/leads/${c.lead_id}`} className="mono" onClick={(e) => e.stopPropagation()}>
                            {c.lead_number}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{c.customer_name ?? '—'}</td>
                      <td>
                        <Badge color={c.direction === 'INBOUND' ? 'cyan' : 'purple'}>{c.direction}</Badge>
                      </td>
                      <td className="mono small">{c.phone_number ?? '—'}</td>
                      <td>
                        <Badge color={STATUS_TONE[c.status] ?? 'gray'}>{c.status.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="text-right">{durationLabel(c.duration_seconds)}</td>
                      <td className="small muted hide-sm">{c.disposition ?? '—'}</td>
                      <td>{c.recording_available ? <Badge color="green">●</Badge> : <span className="muted">—</span>}</td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(c.id);
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {meta ? (
              <Pagination
                page={meta.page}
                totalPages={meta.total_pages}
                total={meta.total}
                onPage={setPage}
                limit={limit}
                onLimit={(n) => {
                  setLimit(n);
                  setPage(1);
                }}
              />
            ) : null}
          </>
        )}
      </div>

      {logOpen ? (
        <LogCallModal
          onClose={() => setLogOpen(false)}
          onSaved={() => {
            setLogOpen(false);
            reloadAll();
            toast.push('success', 'Call logged');
          }}
        />
      ) : null}

      {selectedId && detail?.data ? (
        <Drawer title={`Call · ${detail.data.phone_number ?? detail.data.customer_name ?? 'details'}`} onClose={() => setSelectedId(null)}>
          <CallDetail
            call={detail.data}
            recording={recording?.data}
            canLog={can('calls:create')}
            canDeleteRec={can('calls:update') || (can('calls:update_own') && detail.data.worker_id === user?.id)}
            onLogNextAction={() => setNextOpen(true)}
            onRecordingDeleted={() => {
              reloadAll();
              reloadDetail();
              reloadRecording();
            }}
            onLeadChanged={reloadAll}
          />
        </Drawer>
      ) : null}

      {nextOpen && detail?.data ? (
        <NextActionModal
          call={detail.data}
          onClose={() => setNextOpen(false)}
          onSaved={() => {
            setNextOpen(false);
            reloadAll();
            reloadDetail();
            toast.push('success', 'Next action recorded', 'Follow-up and lead status updated.');
          }}
        />
      ) : null}
    </>
  );
}

function CallDetail({
  call,
  recording,
  canLog,
  canDeleteRec,
  onLogNextAction,
  onRecordingDeleted,
}: {
  call: any;
  recording?: any;
  canLog: boolean;
  canDeleteRec: boolean;
  onLogNextAction: () => void;
  onRecordingDeleted: () => void;
  onLeadChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const deleteRec = async () => {
    setBusy(true);
    try {
      const res = await del(`/api/calls/${call.id}/recording`);
      void res;
      toast.push('success', 'Recording removed');
      onRecordingDeleted();
    } catch (err) {
      toast.push('error', 'Delete failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge color={STATUS_TONE[call.status] ?? 'gray'}>{call.status.replace(/_/g, ' ')}</Badge>
        <Badge color={call.direction === 'INBOUND' ? 'cyan' : 'purple'}>{call.direction}</Badge>
        {call.recording_available ? <Badge color="green">Recording</Badge> : null}
        {call.has_follow_up ? <Badge color="amber">Follow-up linked</Badge> : null}
      </div>

      <div className="stack small" style={{ gap: 7 }}>
        <Row label="Phone" value={call.phone_number ?? '—'} mono />
        <Row label="Started" value={formatDateTime(call.started_at ?? call.created_at)} />
        <Row label="Answered" value={formatDateTime(call.answered_at)} />
        <Row label="Ended" value={formatDateTime(call.ended_at)} />
        <Row label="Duration" value={durationLabel(call.duration_seconds)} />
        <Row label="Worker" value={call.worker_name ?? '—'} />
        <Row label="Provider" value={call.provider ?? '—'} />
        <Row label="Disposition" value={call.disposition ?? '—'} />
        <Row label="Consent" value={call.consent ?? '—'} />
        {call.lead_id ? (
          <div className="row small">
            <span className="muted" style={{ width: 90 }}>Lead</span>
            <Link to={`/leads/${call.lead_id}`} className="mono">
              {call.lead_number} →
            </Link>
          </div>
        ) : null}
        {call.follow_up_id ? (
          <div className="row small">
            <span className="muted" style={{ width: 90 }}>Follow-up</span>
            <span>
              {call.follow_up_date}
              {call.follow_up_time ? ` · ${call.follow_up_time}` : ''} · {call.follow_up_status}
            </span>
          </div>
        ) : null}
      </div>

      {call.notes ? (
        <>
          <div className="divider" />
          <div className="small muted">Notes</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{call.notes}</div>
        </>
      ) : null}

      <div className="divider" />
      <div className="small muted">Recording</div>
      {!call.recording_available ? (
        <div className="small muted">No recording for this call.</div>
      ) : !recording || recording.available === false ? (
        <div className="small muted">Recording metadata is being processed…</div>
      ) : recording.can_play === false ? (
        <div className="small" style={{ color: 'var(--danger)' }}>{recording.reason ?? 'Playback not permitted or recording expired.'}</div>
      ) : recording.storage === 'local' || recording.storage === 'provider' ? (
        <div className="stack" style={{ gap: 8 }}>
          <audio controls preload="none" style={{ width: '100%' }} src={`/api/calls/${call.id}/recording/stream`} />
          <div className="small muted">
            {durationLabel(recording.duration_seconds ?? call.duration_seconds)}
            {recording.retention_until ? ` · kept until ${recording.retention_until}` : ''}
          </div>
          {canDeleteRec ? (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={deleteRec}>
              Delete recording
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="divider" />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!canLog} onClick={onLogNextAction}>
          Log next action
        </button>
      </div>
      <div className="small muted">Creates the follow-up, updates the customer response and moves the lead status in one step.</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row">
      <span className="muted" style={{ width: 90 }}>{label}</span>
      <span className={mono ? 'mono' : ''}>{value}</span>
    </div>
  );
}

function LogCallModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<any | null>(null);
  const [direction, setDirection] = useState('OUTBOUND');
  const [status, setStatus] = useState('COMPLETED');
  const [duration, setDuration] = useState('');
  const [disposition, setDisposition] = useState('');
  const [notes, setNotes] = useState('');
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString().slice(0, 16));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead) {
      setError('Pick a lead first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post('/api/calls', {
        lead_id: lead.id,
        direction,
        status,
        duration_seconds: duration ? Math.max(0, Math.round(Number(duration))) : null,
        disposition: disposition || null,
        notes: notes || null,
        started_at: startedAt ? new Date(startedAt).toISOString() : null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to log call');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log a call"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="log-call-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Log call'}
          </button>
        </>
      }
    >
      <form id="log-call-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <LeadPicker value={lead} onChange={setLead} />
        <div className="form-grid">
          <Field label="Direction" required>
            <select className="select" value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="OUTBOUND">Outbound</option>
              <option value="INBOUND">Inbound</option>
            </select>
          </Field>
          <Field label="Outcome" required>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {CALL_STATUSES.map((c) => (
                <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
          <Field label="Duration (seconds)">
            <input className="input" type="number" min={0} max={604800} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="e.g. 185" />
          </Field>
          <Field label="Started at">
            <input className="input" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Disposition">
          <input className="input" value={disposition} onChange={(e) => setDisposition(e.target.value)} placeholder="e.g. Interested, Callback requested" maxLength={60} />
        </Field>
        <Field label="Notes">
          <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed?" />
        </Field>
      </form>
    </Modal>
  );
}

function NextActionModal({ call, onClose, onSaved }: { call: any; onClose: () => void; onSaved: () => void }) {
  const { statuses } = useMeta();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withFu, setWithFu] = useState(true);
  const tomorrow = useMemo(() => {
    const d = new Date(Date.now() + 86400000);
    return d.toISOString().slice(0, 10);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        disposition: (fd.get('disposition') as string) || null,
        customer_response: (fd.get('customer_response') as string) || null,
        next_action: (fd.get('next_action') as string) || null,
        lead_status: (fd.get('lead_status') as string) || null,
      };
      if (withFu) {
        body.follow_up = {
          scheduled_date: fd.get('scheduled_date'),
          scheduled_time: (fd.get('scheduled_time') as string) || null,
          type: fd.get('type'),
          notes: (fd.get('fu_notes') as string) || null,
        };
      }
      await post(`/api/calls/${call.id}/next-action`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log next action"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="next-action-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save next action'}
          </button>
        </>
      }
    >
      <form id="next-action-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <div className="form-grid">
          <Field label="Call outcome">
            <input className="input" name="disposition" defaultValue={call.disposition ?? ''} placeholder="e.g. Interested in Goa package" maxLength={60} />
          </Field>
          <Field label="Move lead to">
            <select className="select" name="lead_status" defaultValue="">
              <option value="">Keep current status</option>
              {statuses.filter((s: any) => s.is_active).map((s: any) => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Customer response">
          <input className="input" name="customer_response" placeholder="What did the customer say?" maxLength={500} />
        </Field>
        <Field label="Next action">
          <input className="input" name="next_action" placeholder="e.g. Send revised quotation" maxLength={300} />
        </Field>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={withFu} onChange={(e) => setWithFu(e.target.checked)} />
          Schedule a follow-up now
        </label>
        {withFu ? (
          <div className="form-grid">
            <Field label="Follow-up date" required>
              <input className="input" type="date" name="scheduled_date" defaultValue={tomorrow} required />
            </Field>
            <Field label="Time">
              <input className="input" type="time" name="scheduled_time" defaultValue="10:00" />
            </Field>
            <Field label="Type">
              <select className="select" name="type" defaultValue="Call">
                <option>Call</option>
                <option>WhatsApp</option>
                <option>Email</option>
                <option>Meeting</option>
              </select>
            </Field>
          </div>
        ) : null}
        {withFu ? (
          <Field label="Follow-up notes">
            <textarea className="textarea" name="fu_notes" rows={2} placeholder="What should happen on the follow-up?" />
          </Field>
        ) : null}
      </form>
    </Modal>
  );
}
