import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, patch, post, qs } from '../api/client';
import { useQuery } from '../lib/useQuery';
import { formatDate, timeAgo } from '../lib/format';
import { Avatar, EmptyState, ErrorState, Field, Pagination, TableSkeleton, WorkerStatusBadge } from '../ui/atoms';
import { Drawer, Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

interface Worker {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  username?: string | null;
  role: 'ADMIN' | 'WORKER';
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  last_login_at?: string | null;
  created_at: string;
  lead_count: number;
  open_lead_count: number;
}

export default function Workers() {
  const toast = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [editWorker, setEditWorker] = useState<Worker | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const url = `/api/users${qs({ search, status, role, page, limit })}`;
  const { data, loading, error, reload } = useQuery<{ data: Worker[]; meta: any }>(url, [reloadKey]);

  const refresh = () => {
    setReloadKey((k) => k + 1);
    reload();
  };

  const toggleStatus = async (worker: Worker) => {
    const next = worker.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const okConfirm = await confirm({
      title: next === 'ACTIVE' ? `Activate ${worker.name}?` : `Deactivate ${worker.name}?`,
      message:
        next === 'ACTIVE'
          ? 'They will be able to sign in and receive new leads.'
          : 'They will be signed out immediately and cannot log in. Historical data is preserved.',
      confirmLabel: next === 'ACTIVE' ? 'Activate' : 'Deactivate',
      danger: next !== 'ACTIVE',
    });
    if (!okConfirm) return;
    try {
      await patch(`/api/users/${worker.id}/status`, { status: next });
      toast.push('success', `Worker ${next === 'ACTIVE' ? 'activated' : 'deactivated'}`, worker.name);
      refresh();
    } catch (err) {
      toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workers</h1>
          <div className="sub">{data?.meta ? `${data.meta.total} team members` : 'Loading…'}</div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            + New worker
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="grow input-search">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Search name, email, phone, username…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          <option value="ADMIN">Admin</option>
          <option value="WORKER">Worker</option>
        </select>
        {(search || status || role) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setSearch('');
              setStatus('');
              setRole('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data?.data?.length ? (
          <EmptyState title="No workers found" description="Create your first worker to start assigning leads." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th className="hide-sm">Phone</th>
                    <th className="text-right">Open leads</th>
                    <th className="text-right hide-sm">Total leads</th>
                    <th className="hide-sm">Last login</th>
                    <th className="hide-sm">Created</th>
                    <th className="actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <div className="row" style={{ gap: 9 }}>
                          <Avatar name={w.name} />
                          <div>
                            <div className="cell-main">{w.name}</div>
                            <div className="cell-sub">{w.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${w.role === 'ADMIN' ? 'badge-purple' : 'badge-blue'}`}>{w.role}</span>
                      </td>
                      <td>
                        <WorkerStatusBadge status={w.status} />
                      </td>
                      <td className="hide-sm nowrap">{w.phone ?? '—'}</td>
                      <td className="text-right">
                        <strong>{w.open_lead_count}</strong>
                      </td>
                      <td className="text-right hide-sm">{w.lead_count}</td>
                      <td className="hide-sm small muted nowrap">{w.last_login_at ? timeAgo(w.last_login_at) : 'Never'}</td>
                      <td className="hide-sm small muted nowrap">{formatDate(w.created_at)}</td>
                      <td className="actions-cell">
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-sm" onClick={() => setDetailId(w.id)}>
                            View
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => setEditWorker(w)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className={`btn btn-sm ${w.status === 'ACTIVE' ? '' : 'btn-primary'}`}
                            onClick={() => toggleStatus(w)}
                          >
                            {w.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.meta ? (
              <Pagination
                page={data.meta.page}
                totalPages={data.meta.total_pages}
                total={data.meta.total}
                limit={data.meta.limit}
                onLimit={(n) => {
                  setLimit(n);
                  setPage(1);
                }}
                onPage={setPage}
              />
            ) : null}
          </>
        )}
      </div>

      {createOpen ? (
        <WorkerModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
            toast.push('success', 'Worker created');
          }}
        />
      ) : null}

      {editWorker ? (
        <WorkerModal
          initial={editWorker}
          onClose={() => setEditWorker(null)}
          onSaved={() => {
            setEditWorker(null);
            refresh();
            toast.push('success', 'Worker updated');
          }}
        />
      ) : null}

      {detailId ? <WorkerDrawer id={detailId} onClose={() => setDetailId(null)} /> : null}
    </>
  );
}

function WorkerModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Worker;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setError(null);
    const payload: any = {
      name: fd.get('name'),
      email: fd.get('email'),
      phone: fd.get('phone') || null,
      username: fd.get('username') || null,
      role: fd.get('role'),
      status: fd.get('status'),
    };
    const password = String(fd.get('password') || '');
    if (password) payload.password = password;

    try {
      if (initial) await patch(`/api/users/${initial.id}`, payload);
      else await post('/api/users', { ...payload, password });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save worker');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : 'New worker'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="worker-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Create worker'}
          </button>
        </>
      }
    >
      <form id="worker-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Full name" required>
            <input className="input" name="name" required defaultValue={initial?.name ?? ''} />
          </Field>
          <Field label="Email" required>
            <input className="input" type="email" name="email" required defaultValue={initial?.email ?? ''} />
          </Field>
          <Field label="Phone">
            <input className="input" name="phone" defaultValue={initial?.phone ?? ''} />
          </Field>
          <Field label="Username" hint="Optional — can be used to sign in">
            <input className="input" name="username" defaultValue={initial?.username ?? ''} />
          </Field>
          <Field label="Role" required>
            <select className="select" name="role" defaultValue={initial?.role ?? 'WORKER'}>
              <option value="WORKER">Worker</option>
              <option value="ADMIN">Admin / Owner</option>
            </select>
          </Field>
          <Field label="Status" required>
            <select className="select" name="status" defaultValue={initial?.status ?? 'ACTIVE'}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </Field>
          <Field
            label={initial ? 'New password (optional)' : 'Password'}
            required={!initial}
            hint={initial ? 'Leave blank to keep the current password' : 'Min 8 characters with letters and numbers'}
          >
            <input
              className="input"
              type="password"
              name="password"
              required={!initial}
              minLength={initial ? undefined : 8}
              placeholder={initial ? '••••••••' : ''}
            />
          </Field>
        </div>
        <div className="small muted">
          Workers are never deleted — deactivate them instead so their CRM history stays intact.
        </div>
      </form>
    </Modal>
  );
}

function WorkerDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: payload, loading, error, reload } = useQuery<any>(`/api/users/${id}`);
  const { data: activity } = useQuery<{ data: any[] }>(`/api/users/${id}/activity?limit=15`);
  const data = payload?.data;

  return (
    <Drawer title={loading ? 'Worker' : data?.name ?? 'Worker'} onClose={onClose}>
      {loading ? (
        <TableSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data ? (
        <div className="stack">
          <div className="row" style={{ gap: 12 }}>
            <Avatar name={data.name} lg />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{data.name}</div>
              <div className="small muted">{data.email}</div>
            </div>
            <div className="right">
              <WorkerStatusBadge status={data.status} />
            </div>
          </div>

          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="kpi accent">
              <div className="label">Open leads</div>
              <div className="value">{data.workload?.open ?? 0}</div>
            </div>
            <div className="kpi accent-cyan">
              <div className="label">Total leads</div>
              <div className="value">{data.workload?.total ?? 0}</div>
            </div>
            <div className="kpi accent-amber">
              <div className="label">Today's follow-ups</div>
              <div className="value">{data.workload?.today_fu ?? 0}</div>
            </div>
            <div className="kpi accent-red">
              <div className="label">Overdue</div>
              <div className="value">{data.workload?.overdue_fu ?? 0}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Account</h3>
            </div>
            <div className="card-body small stack" style={{ gap: 7 }}>
              <div>
                <span className="muted">Role:</span> {data.role}
              </div>
              <div>
                <span className="muted">Username:</span> {data.username ?? '—'}
              </div>
              <div>
                <span className="muted">Phone:</span> {data.phone ?? '—'}
              </div>
              <div>
                <span className="muted">Last login:</span> {data.last_login_at ? formatDate(data.last_login_at) : 'Never'}
              </div>
              <div>
                <span className="muted">Created:</span> {formatDate(data.created_at)}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Recent activity</h3>
              <span className="right small muted">{activity?.data?.length ?? 0} events</span>
            </div>
            <div className="card-body">
              {!activity?.data?.length ? (
                <div className="small muted">No recorded activity yet.</div>
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {activity.data.map((a) => (
                    <div key={a.id} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                      <span className="small muted nowrap" style={{ whiteSpace: 'nowrap', minWidth: 74 }}>
                        {timeAgo(a.created_at)}
                      </span>
                      <span className="small">{a.summary}</span>
                      {a.lead_id ? (
                        <Link className="small mono right" to={`/leads/${a.lead_id}`} style={{ marginLeft: 'auto' }}>
                          {a.lead_number}
                        </Link>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
