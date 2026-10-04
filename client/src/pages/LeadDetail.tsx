import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, del, get, patch, post, qs } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMeta } from '../lib/meta';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime, timeAgo } from '../lib/format';
import {
  Badge,
  EmptyState,
  ErrorState,
  Field,
  FollowUpStatusBadge,
  LoadingState,
  PriorityBadge,
  StatusBadge,
  Tabs,
} from '../ui/atoms';
import { Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';
import { LeadCallsTab, LeadDocumentsTab, LeadMessagesTab, LeadQuotationsTab } from './LeadPanels';

const TIMELINE_ICONS: Record<string, string> = {
  LEAD_CREATED: '+',
  LEAD_UPDATED: '✎',
  ASSIGNED: '→',
  REASSIGNED: '⇄',
  UNASSIGNED: '×',
  STATUS_CHANGED: '⚑',
  NOTE_ADDED: '✎',
  FOLLOW_UP_CREATED: '◷',
  FOLLOW_UP_UPDATED: '◷',
  FOLLOW_UP_COMPLETED: '✓',
};

export default function LeadDetail() {
  const { id } = useParams();
  const leadId = Number(id);
  const { can, user } = useAuth();
  const { statuses } = useMeta();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [reloadKey, setReloadKey] = useState(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useQuery<any>(`/api/leads/${leadId}`, [reloadKey]);
  const { data: timeline, reload: reloadTimeline } = useQuery<{ data: any[] }>(`/api/leads/${leadId}/timeline`, [reloadKey]);
  const { data: notes, reload: reloadNotes } = useQuery<{ data: any[] }>(`/api/leads/${leadId}/notes`, [reloadKey]);
  const { data: assignments, reload: reloadAssignments } = useQuery<{ data: any[] }>(
    `/api/leads/${leadId}/assignments`,
    [reloadKey],
  );
  const { data: followUps, reload: reloadFollowUps } = useQuery<{ data: any[] }>(
    `/api/follow-ups${qs({ lead_id: leadId, limit: 50 })}`,
    [reloadKey],
  );
  const { data: calls, reload: reloadCalls } = useQuery<{ data: any[] }>(
    `/api/calls${qs({ lead_id: leadId, limit: 50 })}`,
    [reloadKey],
  );
  const { data: quotations, reload: reloadQuotations } = useQuery<{ data: any[] }>(
    `/api/quotations${qs({ lead_id: leadId, limit: 50 })}`,
    [reloadKey],
  );
  const { data: documents, reload: reloadDocuments } = useQuery<{ data: any[] }>(
    `/api/documents${qs({ entity: 'LEAD', entity_id: leadId, limit: 50 })}`,
    [reloadKey],
  );
  const { data: messages, reload: reloadMessages } = useQuery<{ data: any[] }>(
    `/api/communications${qs({ lead_id: leadId, limit: 50 })}`,
    [reloadKey],
  );

  const reloadAll = () => setReloadKey((k) => k + 1);

  if (loading) return <LoadingState label="Loading lead…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="Lead not found" />;
  const lead = data.data ?? ({} as any);

  const canWrite =
    can('leads:update') || (can('leads:update_own') && lead.assignee?.id === user?.id);

  const changeStatus = async (code: string, remark?: string) => {
    setBusy(true);
    try {
      await post(`/api/leads/${leadId}/status`, { status: code, remark });
      toast.push('success', 'Status updated', `Lead is now ${code.replace(/_/g, ' ').toLowerCase()}`);
      setStatusOpen(false);
      reloadAll();
      reloadTimeline();
    } catch (err) {
      toast.push('error', 'Could not update status', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const assign = async (workerId: number | null, reason?: string) => {
    setBusy(true);
    try {
      await post(`/api/leads/${leadId}/assign`, { worker_id: workerId, reason: reason || null });
      toast.push('success', workerId ? 'Lead assigned' : 'Lead unassigned');
      setAssignOpen(false);
      reloadAll();
    } catch (err) {
      toast.push('error', 'Assignment failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    const okConfirm = await confirm({
      title: 'Archive lead?',
      message: 'The lead will be hidden from lists. History and records are preserved.',
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!okConfirm) return;
    toast.push('info', 'Archiving is not enabled', 'Leads are never deleted — history stays for reporting.');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <Link to="/leads" className="small">
              ← Leads
            </Link>
            <span className="mono cell-main" style={{ fontSize: 17 }}>
              {lead.lead_number}
            </span>
            <StatusBadge code={lead.status?.code} name={lead.status?.name} color={lead.status?.color} />
            <PriorityBadge priority={lead.priority} />
          </div>
          <div className="sub">
            {lead.customer?.name} · {lead.customer?.phone ?? 'no phone'} · {lead.destination} · created{' '}
            {timeAgo(lead.created_at)}
          </div>
        </div>
        <div className="actions">
          {canWrite ? (
            <button type="button" className="btn" onClick={() => setStatusOpen(true)}>
              Change status
            </button>
          ) : null}
          {can('leads:assign') ? (
            <button type="button" className="btn" onClick={() => setAssignOpen(true)}>
              {lead.assignee ? 'Reassign' : 'Assign'}
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => setFollowUpOpen(true)} disabled={!can('follow_ups:create')}>
            + Follow-up
          </button>
          {can('leads:update') ? (
            <button type="button" className="btn btn-ghost" onClick={archive}>
              Archive
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: '2fr 1fr', alignItems: 'start' }}>
        <div className="stack">
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'overview', label: 'Overview' },
              { key: 'followups', label: 'Follow-ups', count: followUps?.data?.length ?? 0 },
              { key: 'calls', label: 'Calls', count: calls?.data?.length ?? 0 },
              { key: 'quotations', label: 'Quotations', count: quotations?.data?.length ?? 0 },
              { key: 'documents', label: 'Documents', count: documents?.data?.length ?? 0 },
              { key: 'messages', label: 'Messages', count: messages?.data?.length ?? 0 },
              { key: 'notes', label: 'Notes', count: notes?.data?.length ?? 0 },
              { key: 'timeline', label: 'Timeline', count: timeline?.data?.length ?? 0 },
            ]}
          />

          {tab === 'overview' ? (
            <>
              <div className="card">
                <div className="card-head">
                  <h3>Travel requirements</h3>
                </div>
                <div className="card-body">
                  <div className="form-grid" style={{ gap: 14 }}>
                    <Detail label="Destination" value={lead.destination} />
                    <Detail label="Travel type" value={lead.travel_type === 'INTERNATIONAL' ? 'International' : 'Domestic'} />
                    <Detail label="Trip type" value={lead.trip_type ?? '—'} />
                    <Detail label="Source" value={lead.source?.name ?? 'Unknown'} />
                    <Detail label="Start date" value={formatDate(lead.travel_start_date)} />
                    <Detail label="End date" value={formatDate(lead.travel_end_date)} />
                    <Detail
                      label="Travellers"
                      value={`${lead.adults} adult(s)${lead.children ? `, ${lead.children} child(ren)` : ''} · ${lead.total_travelers} total`}
                    />
                    <Detail label="Budget" value={formatCurrency(lead.budget, lead.currency)} />
                    <Detail label="Last contacted" value={formatDateTime(lead.last_contacted_at)} />
                    <Detail label="Next follow-up (manual)" value={formatDateTime(lead.next_follow_up_at)} />
                  </div>
                  {lead.requirements?.length ? (
                    <>
                      <div className="divider" />
                      <div className="row" style={{ gap: 7 }}>
                        {lead.requirements.map((r: string) => (
                          <Badge key={r} color="cyan">
                            {r}
                          </Badge>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {lead.notes ? (
                    <>
                      <div className="divider" />
                      <div className="small muted">Notes</div>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{lead.notes}</div>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Status history</h3>
                </div>
                <div className="card-body tight">
                  {lead.status_history?.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Change</th>
                            <th>By</th>
                            <th>Remark</th>
                            <th>When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lead.status_history.map((h: any) => (
                            <tr key={h.id}>
                              <td>
                                {h.from_name ? `${h.from_name} → ` : ''}
                                <strong>{h.to_name}</strong>
                              </td>
                              <td>{h.changed_by_name ?? 'System'}</td>
                              <td className="muted">{h.remark ?? '—'}</td>
                              <td className="small muted nowrap">{formatDateTime(h.changed_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState title="No status changes yet" />
                  )}
                </div>
              </div>
            </>
          ) : null}

          {tab === 'followups' ? (
            <div className="card">
              <div className="card-head">
                <h3>Follow-ups</h3>
                <div className="right">
                  <button type="button" className="btn btn-sm" onClick={() => setFollowUpOpen(true)} disabled={!can('follow_ups:create')}>
                    + Schedule
                  </button>
                </div>
              </div>
              <div className="card-body tight">
                {!followUps?.data?.length ? (
                  <EmptyState
                    title="No follow-ups scheduled"
                    description="Schedule the next action so nothing slips through."
                    action={
                      can('follow_ups:create') ? (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setFollowUpOpen(true)}>
                          + Schedule follow-up
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  followUps.data.map((fu: any) => (
                    <FollowUpRow
                      key={fu.id}
                      fu={fu}
                      canUpdate={can('follow_ups:update') || (can('follow_ups:update_own') && fu.worker?.id === user?.id)}
                      onChanged={() => {
                        reloadAll();
                        reloadFollowUps();
                        reloadTimeline();
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          ) : null}

          {tab === 'notes' ? (
            <div className="card">
              <div className="card-head">
                <h3>Notes</h3>
                <div className="right">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setNoteOpen(true)}
                    disabled={!can('notes:create')}
                  >
                    + Add note
                  </button>
                </div>
              </div>
              <div className="card-body">
                {!notes?.data?.length ? (
                  <EmptyState title="No notes yet" description="Notes are append-only — nothing is ever overwritten." />
                ) : (
                  <div className="stack" style={{ gap: 12 }}>
                    {notes.data.map((n: any) => (
                      <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                        <div className="row" style={{ gap: 8, marginBottom: 5 }}>
                          <strong style={{ fontSize: 13 }}>{n.author_name}</strong>
                          <span className="small muted">{formatDateTime(n.created_at)}</span>
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{n.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === 'timeline' ? (
            <div className="card">
              <div className="card-head">
                <h3>Lead timeline</h3>
                <span className="right small muted">Chronological history of everything that happened</span>
              </div>
              <div className="card-body">
                {!timeline?.data?.length ? (
                  <EmptyState title="No events yet" />
                ) : (
                  <div className="timeline">
                    {timeline.data.map((ev: any) => (
                      <div className="tl-item" key={ev.id}>
                        <div className="tl-dot">{TIMELINE_ICONS[ev.type] ?? '•'}</div>
                        <div className="tl-body">
                          <div className="tl-summary">{ev.summary}</div>
                          <div className="tl-time">
                            <Badge color="outline">{ev.type.replace(/_/g, ' ')}</Badge>{' '}
                            {formatDateTime(ev.created_at)} {ev.actor_name ? `· ${ev.actor_name}` : ''}
                          </div>
                          {ev.metadata && ev.metadata.to_name ? (
                            <div className="tl-meta">
                              {ev.metadata.from_name} → {ev.metadata.to_name}
                              {ev.metadata.reason ? ` · ${ev.metadata.reason}` : ''}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === 'calls' ? (
            <LeadCallsTab lead={lead} calls={calls?.data ?? []} onChanged={() => { reloadAll(); reloadCalls(); reloadTimeline(); }} />
          ) : null}

          {tab === 'quotations' ? (
            <LeadQuotationsTab
              leadId={leadId}
              quotations={quotations?.data ?? []}
              onChanged={() => { reloadAll(); reloadQuotations(); reloadTimeline(); }}
            />
          ) : null}

          {tab === 'documents' ? (
            <LeadDocumentsTab
              leadId={leadId}
              documents={documents?.data ?? []}
              onChanged={() => { reloadAll(); reloadDocuments(); }}
            />
          ) : null}

          {tab === 'messages' ? (
            <LeadMessagesTab lead={lead} messages={messages?.data ?? []} onChanged={() => { reloadAll(); reloadMessages(); }} />
          ) : null}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3>Customer</h3>
            </div>
            <div className="card-body">
              <div className="row" style={{ gap: 12, marginBottom: 12 }}>
                <span className="avatar lg">{lead.customer?.name?.slice(0, 1)}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{lead.customer?.name}</div>
                  <div className="small muted">{lead.customer?.city ?? '—'}</div>
                </div>
              </div>
              <div className="stack" style={{ gap: 7 }}>
                <div className="row small">
                  <span className="muted" style={{ width: 70 }}>Phone</span>
                  <span>{lead.customer?.phone ?? '—'}</span>
                </div>
                <div className="row small">
                  <span className="muted" style={{ width: 70 }}>WhatsApp</span>
                  <span>{lead.customer?.whatsapp ?? '—'}</span>
                </div>
                <div className="row small">
                  <span className="muted" style={{ width: 70 }}>Email</span>
                  <span style={{ wordBreak: 'break-all' }}>{lead.customer?.email ?? '—'}</span>
                </div>
              </div>
              <div className="divider" />
              <Link to={`/customers?search=${encodeURIComponent(lead.customer?.name ?? '')}`} className="small">
                View customer record →
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Assignment</h3>
            </div>
            <div className="card-body">
              <div className="row" style={{ gap: 10, marginBottom: 10 }}>
                <span className="avatar">{lead.assignee?.name?.slice(0, 1) ?? '?'}</span>
                <div>
                  <div style={{ fontWeight: 650 }}>{lead.assignee?.name ?? 'Unassigned'}</div>
                  <div className="small muted">{lead.assignee ? 'Current owner' : 'No owner yet'}</div>
                </div>
              </div>
              {can('leads:assign') ? (
                <button type="button" className="btn btn-sm btn-block" onClick={() => setAssignOpen(true)}>
                  {lead.assignee ? 'Reassign lead' : 'Assign lead'}
                </button>
              ) : null}
              <div className="divider" />
              <div className="small muted" style={{ marginBottom: 6 }}>
                History
              </div>
              {assignments?.data?.length ? (
                <div className="stack" style={{ gap: 8 }}>
                  {assignments.data.map((a: any) => (
                    <div key={a.id} className="row small" style={{ gap: 6 }}>
                      <Badge color={a.is_active ? 'green' : 'gray'}>{a.action}</Badge>
                      <span>
                        {a.assigned_to_name} <span className="muted">by {a.assigned_by_name}</span>
                      </span>
                      <span className="muted right">{formatDate(a.assigned_at)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="small muted">No assignment events yet.</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Created by</h3>
            </div>
            <div className="card-body small">
              <div>
                <strong>{lead.created_by_name ?? '—'}</strong>
              </div>
              <div className="muted">{formatDateTime(lead.created_at)}</div>
              <div className="muted">Last updated {timeAgo(lead.updated_at)}</div>
            </div>
          </div>
        </div>
      </div>

      {statusOpen ? (
        <StatusModal
          statuses={statuses}
          current={lead.status?.code}
          busy={busy}
          onClose={() => setStatusOpen(false)}
          onSubmit={changeStatus}
        />
      ) : null}

      {assignOpen ? <AssignModal busy={busy} current={lead.assignee?.id ?? null} onClose={() => setAssignOpen(false)} onSubmit={assign} /> : null}

      {followUpOpen ? (
        <ScheduleFollowUpModal
          leadId={leadId}
          workerId={lead.assignee?.id ?? undefined}
          onClose={() => setFollowUpOpen(false)}
          onCreated={() => {
            setFollowUpOpen(false);
            reloadAll();
            reloadFollowUps();
            reloadTimeline();
          }}
        />
      ) : null}

      {noteOpen ? (
        <AddNoteModal
          leadId={leadId}
          onClose={() => setNoteOpen(false)}
          onAdded={() => {
            setNoteOpen(false);
            reloadNotes();
            reloadTimeline();
          }}
        />
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="small muted" style={{ fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}

function FollowUpRow({ fu, canUpdate, onChanged }: { fu: any; canUpdate: boolean; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: string) => {
    if (status === 'NOT_INTERESTED' || status === 'CANCELLED') {
      const okConfirm = await confirm({
        title: status === 'CANCELLED' ? 'Cancel follow-up?' : 'Mark as not interested?',
        message:
          status === 'CANCELLED'
            ? 'The follow-up will be removed from your board.'
            : 'This also marks the lead as NOT INTERESTED. You can change it later.',
        confirmLabel: status === 'CANCELLED' ? 'Cancel follow-up' : 'Mark not interested',
        danger: true,
      });
      if (!okConfirm) return;
    }
    setBusy(true);
    try {
      if (status === 'CANCELLED') {
        await del(`/api/follow-ups/${fu.id}`);
      } else {
        await patch(`/api/follow-ups/${fu.id}`, { status });
      }
      toast.push('success', 'Follow-up updated', `Status: ${status.replace(/_/g, ' ').toLowerCase()}`);
      onChanged();
    } catch (err) {
      toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const terminal = ['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED'].includes(fu.status);

  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong style={{ fontSize: 13.5 }}>
              {formatDate(fu.scheduled_date)}
              {fu.scheduled_time ? ` · ${fu.scheduled_time}` : ''}
            </strong>
            <Badge color="outline">{fu.type}</Badge>
            <FollowUpStatusBadge status={fu.effective_status} />
          </div>
          <div className="small muted" style={{ marginTop: 3 }}>
            {fu.worker?.name} · {fu.notes || 'No notes'}
          </div>
          {fu.customer_response ? <div className="small">Response: {fu.customer_response}</div> : null}
          {fu.next_action ? <div className="small muted">Next: {fu.next_action}</div> : null}
          {fu.completed_at ? <div className="small muted">Completed {formatDateTime(fu.completed_at)}</div> : null}
        </div>
        {canUpdate ? (
          <div className="row" style={{ gap: 6 }}>
            {!terminal ? (
              <>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStatus('COMPLETED')}>
                  Completed
                </button>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setStatus('CONVERTED')}>
                  Converted
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStatus('NOT_INTERESTED')}>
                  Not interested
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStatus('CANCELLED')}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStatus('PENDING')}>
                Reopen
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusModal({
  statuses,
  current,
  busy,
  onClose,
  onSubmit,
}: {
  statuses: Array<{ code: string; name: string; is_active: number }>;
  current?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (code: string, remark?: string) => void;
}) {
  const [code, setCode] = useState(current ?? '');
  const [remark, setRemark] = useState('');

  return (
    <Modal
      title="Change lead status"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !code || code === current} onClick={() => onSubmit(code, remark)}>
            Update status
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label="New status" required>
          <select className="select" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Select status…</option>
            {statuses
              .filter((s) => s.is_active)
              .map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Remark (optional)">
          <input className="input" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Why is it changing?" />
        </Field>
        <div className="small muted">Every status change is recorded in the lead timeline and audit log.</div>
      </div>
    </Modal>
  );
}

function AssignModal({
  current,
  busy,
  onClose,
  onSubmit,
}: {
  current: number | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (workerId: number | null, reason?: string) => void;
}) {
  const { data: workers } = useQuery<{ data: any[] }>('/api/users?status=ACTIVE&limit=100');
  const [workerId, setWorkerId] = useState<number | ''>(current ?? '');
  const [reason, setReason] = useState('');

  return (
    <Modal
      title="Assign / reassign lead"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onSubmit(workerId === '' ? null : Number(workerId), reason)}
          >
            Save assignment
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Assign to">
          <select className="select" value={workerId} onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Unassigned</option>
            {(workers?.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.open_lead_count} open
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason (optional)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. workload balancing" />
        </Field>
        <div className="small muted">Previous assignments stay in history — nothing is overwritten.</div>
      </div>
    </Modal>
  );
}

function ScheduleFollowUpModal({
  leadId,
  workerId,
  onClose,
  onCreated,
}: {
  leadId: number;
  workerId?: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { followUpTypes } = useMeta();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      await post('/api/follow-ups', {
        lead_id: leadId,
        worker_id: workerId,
        scheduled_date: fd.get('scheduled_date'),
        scheduled_time: fd.get('scheduled_time') || null,
        type: fd.get('type'),
        notes: fd.get('notes') || null,
        next_action: fd.get('next_action') || null,
      });
      toast.push('success', 'Follow-up scheduled');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to schedule');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Schedule follow-up"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="fu-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </>
      }
    >
      <form id="fu-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div> : null}
        <div className="form-grid">
          <Field label="Date" required>
            <input className="input" type="date" name="scheduled_date" required defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="Time">
            <input className="input" type="time" name="scheduled_time" defaultValue="10:00" />
          </Field>
          <Field label="Type">
            <select className="select" name="type" defaultValue="Call">
              {followUpTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" name="notes" placeholder="What should be discussed?" />
        </Field>
        <Field label="Next action">
          <input className="input" name="next_action" placeholder="e.g. Send quotation" />
        </Field>
      </form>
    </Modal>
  );
}

function AddNoteModal({ leadId, onClose, onAdded }: { leadId: number; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setBusy(true);
    try {
      await post(`/api/leads/${leadId}/notes`, { content: content.trim() });
      toast.push('success', 'Note added');
      onAdded();
    } catch (err) {
      toast.push('error', 'Could not add note', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add note"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="note-form" className="btn btn-primary" disabled={busy || !content.trim()}>
            {busy ? 'Saving…' : 'Save note'}
          </button>
        </>
      }
    >
      <form id="note-form" onSubmit={submit}>
        <Field label="Note" required hint="Notes are append-only and appear in the timeline.">
          <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} required rows={5} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
