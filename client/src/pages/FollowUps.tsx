import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, del, patch, post, qs } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMeta } from '../lib/meta';
import { useQuery } from '../lib/useQuery';
import { formatDate } from '../lib/format';
import {
  Badge,
  EmptyState,
  ErrorState,
  Field,
  FollowUpStatusBadge,
  Pagination,
  PriorityBadge,
  StatusBadge,
  TableSkeleton,
  Tabs,
} from '../ui/atoms';
import { Modal, useConfirm } from '../ui/overlays';
import { WorkerPicker } from '../ui/pickers';
import { useToast } from '../ui/Toast';

const COLUMNS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'TODAY', label: 'Today' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CONVERTED', label: 'Converted' },
  { key: 'NOT_INTERESTED', label: 'Not Interested' },
];

const COLUMN_TONE: Record<string, string> = {
  PENDING: '#2563eb',
  TODAY: '#d97706',
  OVERDUE: '#dc2626',
  COMPLETED: '#16a34a',
  CONVERTED: '#0891b2',
  NOT_INTERESTED: '#6b7280',
};

const TERMINAL = ['COMPLETED', 'CONVERTED', 'NOT_INTERESTED', 'CANCELLED'];

export default function FollowUps() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [reloadKey, setReloadKey] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();

  const filters = useMemo(() => {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }, [params]);

  const boardUrl = `/api/follow-ups/board${qs(filters)}`;
  const listUrl = `/api/follow-ups${qs({ ...filters, limit: 20 })}`;

  const board = useQuery<any>(view === 'board' ? boardUrl : null, [reloadKey]);
  const list = useQuery<{ data: any[]; meta: any }>(view === 'list' ? listUrl : null, [reloadKey]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
    setReloadKey((k) => k + 1);
  };

  const changeStatus = async (id: number, status: string) => {
    if (status === 'NOT_INTERESTED') {
      const okConfirm = await confirm({
        title: 'Mark as not interested?',
        message: 'This also sets the lead status to NOT INTERESTED.',
        confirmLabel: 'Mark not interested',
        danger: true,
      });
      if (!okConfirm) return;
    }
    if (status === 'CANCELLED') {
      const okConfirm = await confirm({
        title: 'Cancel this follow-up?',
        message: 'It will be removed from the board.',
        confirmLabel: 'Cancel follow-up',
        danger: true,
      });
      if (!okConfirm) return;
    }
    try {
      if (status === 'CANCELLED') await del(`/api/follow-ups/${id}`);
      else await patch(`/api/follow-ups/${id}`, { status });
      toast.push('success', 'Follow-up updated', status.replace(/_/g, ' ').toLowerCase());
      setReloadKey((k) => k + 1);
      board.reload();
      list.reload();
    } catch (err) {
      toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  const onDrop = async (column: string, fuId: number) => {
    setDragOver(null);
    if (['OVERDUE', 'TODAY'].includes(column)) {
      toast.push('info', 'Reschedule instead', 'Overdue/Today are derived from the scheduled date.');
      return;
    }
    if (column === 'PENDING') {
      const current = findItem(fuId);
      if (current && !TERMINAL.includes(current.status)) return;
      try {
        await patch(`/api/follow-ups/${fuId}`, { status: 'PENDING' });
        setReloadKey((k) => k + 1);
        return;
      } catch (err) {
        toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
        return;
      }
    }
    await changeStatus(fuId, column);
  };

  const findItem = (id: number) => board.data?.data?.columns?.flatMap((c: any) => c.items).find((i: any) => i.id === id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Follow-up board</h1>
          <div className="sub">Drag cards between columns, or use the action buttons on each card.</div>
        </div>
        <div className="actions">
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className={`btn btn-sm${view === 'board' ? ' btn-primary' : ''}`} onClick={() => setView('board')}>
              Board
            </button>
            <button type="button" className={`btn btn-sm${view === 'list' ? ' btn-primary' : ''}`} onClick={() => setView('list')}>
              List
            </button>
          </div>
          {can('follow_ups:create') ? (
            <button type="button" className="btn btn-primary" onClick={() => setScheduleOpen(true)}>
              + Schedule follow-up
            </button>
          ) : null}
        </div>
      </div>

      <div className="toolbar">
        <div className="grow input-search">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Search customer, phone, lead number, destination, worker…"
            defaultValue={params.get('search') ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('search', (e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <select className="select" value={params.get('period') ?? ''} onChange={(e) => setFilter('period', e.target.value)}>
          <option value="">All dates</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
        </select>
        <select className="select" value={params.get('status') ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Any status</option>
          <option value="PENDING">Pending</option>
          <option value="TODAY">Today</option>
          <option value="OVERDUE">Overdue</option>
          <option value="COMPLETED">Completed</option>
          <option value="CONVERTED">Converted</option>
          <option value="NOT_INTERESTED">Not interested</option>
        </select>
        {can('follow_ups:read_all') ? (
          <WorkerPicker value={params.get('worker_id') ?? ''} onChange={(v) => setFilter('worker_id', v)} />
        ) : null}
        <input
          className="input"
          type="date"
          value={params.get('date_from') ?? ''}
          onChange={(e) => setFilter('date_from', e.target.value)}
          title="From date"
        />
        <input
          className="input"
          type="date"
          value={params.get('date_to') ?? ''}
          onChange={(e) => setFilter('date_to', e.target.value)}
          title="To date"
        />
        {params.toString() ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams())}>
            Clear
          </button>
        ) : null}
      </div>

      {view === 'board' ? (
        board.loading ? (
          <TableSkeleton rows={6} />
        ) : board.error ? (
          <ErrorState message={board.error} onRetry={board.reload} />
        ) : (
          <div className="kanban">
            {board.data?.data?.columns?.map((col: any) => (
              <div
                key={col.key}
                className={`kanban-col${dragOver === col.key ? ' drag-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(col.key);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = Number(e.dataTransfer.getData('text/plain'));
                  if (id) void onDrop(col.key, id);
                }}
              >
                <div className="kanban-col-head" style={{ borderTop: `3px solid ${COLUMN_TONE[col.key]}` }}>
                  <span>{col.label}</span>
                  <span className="count">{col.count}</span>
                </div>
                <div className="kanban-col-body">
                  {col.items.length === 0 ? (
                    <div className="kanban-empty">Nothing here</div>
                  ) : (
                    col.items.map((fu: any) => (
                      <div
                        key={fu.id}
                        className="kanban-card"
                        draggable={!['COMPLETED', 'CONVERTED', 'NOT_INTERESTED'].includes(fu.effective_status)}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(fu.id))}
                      >
                        <div className="kc-top">
                          <span className="kc-name">{fu.customer?.name}</span>
                          <PriorityBadge priority={fu.lead_priority} />
                        </div>
                        <div className="kc-sub">
                          {fu.destination} · <span className="mono">{fu.lead_number}</span>
                        </div>
                        <div className="kc-meta">
                          <span className="kc-when">
                            {formatDate(fu.scheduled_date)}
                            {fu.scheduled_time ? ` · ${fu.scheduled_time}` : ''}
                          </span>
                          <Badge color="outline">{fu.type}</Badge>
                        </div>
                        <div className="kc-meta">
                          <StatusBadge code={fu.lead_status} name={fu.lead_status_name} />
                          <span className="small muted">{fu.worker?.name}</span>
                        </div>
                        {fu.next_action ? <div className="small muted" style={{ marginTop: 6 }}>→ {fu.next_action}</div> : null}
                        <div className="kc-meta" style={{ marginTop: 8 }}>
                          {!TERMINAL.includes(fu.status) ? (
                            <>
                              <button type="button" className="btn btn-sm" onClick={() => changeStatus(fu.id, 'COMPLETED')}>
                                Completed
                              </button>
                              <button type="button" className="btn btn-sm btn-primary" onClick={() => changeStatus(fu.id, 'CONVERTED')}>
                                Converted
                              </button>
                              <button type="button" className="btn btn-sm" onClick={() => changeStatus(fu.id, 'NOT_INTERESTED')}>
                                Not interested
                              </button>
                            </>
                          ) : (
                            <Link to={`/leads/${fu.lead_id}`} className="small">
                              Open lead →
                            </Link>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="card">
          {list.loading ? (
            <TableSkeleton rows={8} />
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : !list.data?.data?.length ? (
            <EmptyState title="No follow-ups found" description="Adjust your filters or schedule a new follow-up." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>Lead</th>
                      <th>Worker</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Next action</th>
                      <th className="actions-cell">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.data.map((fu: any) => (
                      <tr key={fu.id}>
                        <td className="nowrap">
                          <div className="cell-main">{formatDate(fu.scheduled_date)}</div>
                          <div className="cell-sub">{fu.scheduled_time ?? '—'}</div>
                        </td>
                        <td>
                          <div className="cell-main">{fu.customer?.name}</div>
                          <div className="cell-sub">{fu.customer?.phone}</div>
                        </td>
                        <td>
                          <Link to={`/leads/${fu.lead_id}`} className="mono">
                            {fu.lead_number}
                          </Link>
                          <div className="cell-sub">{fu.destination}</div>
                        </td>
                        <td>{fu.worker?.name}</td>
                        <td>
                          <Badge color="outline">{fu.type}</Badge>
                        </td>
                        <td>
                          <FollowUpStatusBadge status={fu.effective_status} />
                        </td>
                        <td className="small muted">{fu.next_action ?? '—'}</td>
                        <td className="actions-cell">
                          {!TERMINAL.includes(fu.status) ? (
                            <div className="row" style={{ gap: 5, justifyContent: 'flex-end' }}>
                              <button type="button" className="btn btn-sm" onClick={() => changeStatus(fu.id, 'COMPLETED')}>
                                Done
                              </button>
                              <button type="button" className="btn btn-sm btn-primary" onClick={() => changeStatus(fu.id, 'CONVERTED')}>
                                Converted
                              </button>
                              <button type="button" className="btn btn-sm" onClick={() => changeStatus(fu.id, 'NOT_INTERESTED')}>
                                Not int.
                              </button>
                            </div>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list.data.meta ? (
                <Pagination
                  page={list.data.meta.page}
                  totalPages={list.data.meta.total_pages}
                  total={list.data.meta.total}
                  onPage={(p) => setFilter('page', String(p))}
                />
              ) : null}
            </>
          )}
        </div>
      )}

      {scheduleOpen ? (
        <ScheduleModal
          onClose={() => setScheduleOpen(false)}
          onCreated={() => {
            setScheduleOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </>
  );
}

function ScheduleModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { followUpTypes } = useMeta();
  const { data: leads } = useQuery<{ data: any[] }>('/api/leads?limit=50&sort=recent');
  const { data: workers } = useQuery<{ data: any[] }>('/api/users?limit=100&status=ACTIVE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setError(null);
    try {
      await post('/api/follow-ups', {
        lead_id: Number(fd.get('lead_id')),
        worker_id: fd.get('worker_id') ? Number(fd.get('worker_id')) : undefined,
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
          <button type="submit" form="schedule-fu" className="btn btn-primary" disabled={busy}>
            {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </>
      }
    >
      <form id="schedule-fu" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <Field label="Lead" required>
          <select className="select" name="lead_id" required defaultValue="">
            <option value="">Select lead…</option>
            {(leads?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.lead_number} · {l.customer?.name} → {l.destination}
              </option>
            ))}
          </select>
        </Field>
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
          <Field label="Worker">
            <select className="select" name="worker_id" defaultValue="">
              <option value="">Lead owner (default)</option>
              {(workers?.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" name="notes" placeholder="What needs to be discussed?" />
        </Field>
        <Field label="Next action">
          <input className="input" name="next_action" placeholder="e.g. Send quotation" />
        </Field>
      </form>
    </Modal>
  );
}
