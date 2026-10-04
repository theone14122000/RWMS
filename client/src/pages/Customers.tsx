import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, patch, post, qs } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatDate, timeAgo } from '../lib/format';
import { EmptyState, ErrorState, Field, Pagination, StatusBadge, TableSkeleton } from '../ui/atoms';
import { Drawer, Modal } from '../ui/overlays';
import { useToast } from '../ui/Toast';

interface Customer {
  id: number;
  name: string;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  notes?: string | null;
  lead_count: number;
  created_at: string;
}

export default function Customers() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const toast = useToast();

  const search = params.get('search') ?? '';
  const page = params.get('page') ?? '1';
  const limit = params.get('limit') ?? '20';

  const url = `/api/customers${qs({ search, page, limit })}`;
  const { data, loading, error, reload } = useQuery<{ data: Customer[]; meta: any }>(url);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <div className="sub">{data?.meta ? `${data.meta.total} customer records` : 'Loading…'}</div>
        </div>
        <div className="actions">
          {can('customers:manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              + New customer
            </button>
          ) : null}
        </div>
      </div>

      <div className="toolbar">
        <div className="grow input-search">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Search name, phone, WhatsApp, email, city…"
            defaultValue={search}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('search', (e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <select className="select" value={params.get('sort') ?? 'recent'} onChange={(e) => setFilter('sort', e.target.value)}>
          <option value="recent">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name (A–Z)</option>
        </select>
        {search ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilter('search', '')}>
            Clear
          </button>
        ) : null}
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={8} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data?.data?.length ? (
          <EmptyState
            title="No customers found"
            description="Customers are created automatically when you create a lead, or add one directly."
            action={
              can('customers:manage') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  + New customer
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
                    <th>Name</th>
                    <th>Phone</th>
                    <th className="hide-sm">WhatsApp</th>
                    <th className="hide-sm">Email</th>
                    <th className="hide-sm">City</th>
                    <th>Leads</th>
                    <th>Created</th>
                    <th className="actions-cell"> </th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => setSelectedId(c.id)}>
                      <td>
                        <div className="cell-main">{c.name}</div>
                        <div className="cell-sub">{c.country ?? ''}</div>
                      </td>
                      <td className="nowrap">{c.phone ?? '—'}</td>
                      <td className="hide-sm nowrap">{c.whatsapp ?? '—'}</td>
                      <td className="hide-sm" style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.email ?? '—'}
                      </td>
                      <td className="hide-sm">{c.city ?? '—'}</td>
                      <td>
                        <span className="badge badge-blue">{c.lead_count}</span>
                      </td>
                      <td className="muted small nowrap">{formatDate(c.created_at)}</td>
                      <td className="actions-cell">
                        <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setSelectedId(c.id); }}>
                          View
                        </button>
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
                onLimit={(n) => setFilter('limit', String(n))}
                onPage={(p) => setFilter('page', String(p))}
              />
            ) : null}
          </>
        )}
      </div>

      {createOpen ? (
        <CustomerModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            reload();
            if (id) setSelectedId(id);
            toast.push('success', 'Customer created');
          }}
        />
      ) : null}

      {selectedId ? (
        <CustomerDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function CustomerModal({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (id?: number) => void;
  initial?: Partial<Customer>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<any[] | null>(null);

  const submit = async (e: FormEvent, allowDuplicate = false) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const payload = {
      name: fd.get('name'),
      phone: fd.get('phone') || null,
      whatsapp: fd.get('whatsapp') || fd.get('phone') || null,
      email: fd.get('email') || null,
      city: fd.get('city') || null,
      state: fd.get('state') || null,
      country: fd.get('country') || null,
      notes: fd.get('notes') || null,
      allow_duplicate: allowDuplicate,
    };
    try {
      const res = initial?.id
        ? await patch<{ data: Customer }>(`/api/customers/${initial.id}`, payload)
        : await post<{ data: Customer }>('/api/customers', payload);
      onCreated(res.data.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setDuplicates((err.details as any)?.duplicates ?? []);
        setError('Possible duplicate found. Confirm to save anyway.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to save customer');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial?.id ? 'Edit customer' : 'New customer'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="customer-form"
            className="btn btn-primary"
            disabled={busy}
          >
            {busy ? 'Saving…' : duplicates?.length && error ? 'Save anyway' : 'Save customer'}
          </button>
        </>
      }
    >
      <form id="customer-form" onSubmit={(e) => submit(e, Boolean(duplicates?.length))} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--warning-50)', color: '#92400e', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>
            {error}
            {duplicates?.length ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {duplicates.map((d) => (
                  <li key={d.id}>
                    {d.name} · {d.phone ?? d.email}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Full name" required>
            <input className="input" name="name" required defaultValue={initial?.name ?? ''} />
          </Field>
          <Field label="Phone">
            <input className="input" name="phone" defaultValue={initial?.phone ?? ''} />
          </Field>
          <Field label="WhatsApp">
            <input className="input" name="whatsapp" defaultValue={initial?.whatsapp ?? ''} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" name="email" defaultValue={initial?.email ?? ''} />
          </Field>
          <Field label="City">
            <input className="input" name="city" defaultValue={initial?.city ?? ''} />
          </Field>
          <Field label="State">
            <input className="input" name="state" defaultValue={initial?.state ?? ''} />
          </Field>
          <Field label="Country">
            <input className="input" name="country" defaultValue={initial?.country ?? ''} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" name="notes" defaultValue={initial?.notes ?? ''} rows={3} />
        </Field>
      </form>
    </Modal>
  );
}

function CustomerDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const toast = useToast();
  const { data: payload, loading, error, reload } = useQuery<any>(`/api/customers/${id}`);
  const data = payload?.data;

  return (
    <>
      <Drawer title={loading ? 'Customer' : data?.name ?? 'Customer'} onClose={onClose}>
        {loading ? (
          <TableSkeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : data ? (
          <div className="stack">
            <div className="row" style={{ gap: 12 }}>
              <span className="avatar lg">{data.name?.slice(0, 1)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{data.name}</div>
                <div className="small muted">
                  {data.city ?? '—'}
                  {data.state ? `, ${data.state}` : ''} {data.country ? `· ${data.country}` : ''}
                </div>
              </div>
              {can('customers:manage') ? (
                <button type="button" className="btn btn-sm" onClick={() => setEditOpen(true)}>
                  Edit
                </button>
              ) : null}
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Contact</h3>
              </div>
              <div className="card-body small stack" style={{ gap: 7 }}>
                <div>
                  <span className="muted">Phone:</span> {data.phone ?? '—'}
                </div>
                <div>
                  <span className="muted">WhatsApp:</span> {data.whatsapp ?? '—'}
                </div>
                <div style={{ wordBreak: 'break-all' }}>
                  <span className="muted">Email:</span> {data.email ?? '—'}
                </div>
                <div>
                  <span className="muted">Created:</span> {formatDate(data.created_at)}
                </div>
                {data.notes ? (
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    <span className="muted">Notes:</span> {data.notes}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Leads ({data.leads.length})</h3>
              </div>
              <div className="card-body tight">
                {!data.leads.length ? (
                  <EmptyState title="No leads yet" />
                ) : (
                  data.leads.map((l: any) => (
                    <div key={l.id} style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
                      <div className="row" style={{ gap: 8 }}>
                        <Link to={`/leads/${l.id}`} className="mono cell-main">
                          {l.lead_number}
                        </Link>
                        <StatusBadge code={l.status.code} name={l.status.name} color={l.status.color} />
                        <span className="right small muted">{formatDate(l.created_at)}</span>
                      </div>
                      <div className="small muted">
                        {l.destination} · {l.trip_type ?? '—'} · {l.assignee?.name ?? 'Unassigned'}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {data.duplicates?.length ? (
              <div className="card" style={{ borderColor: 'var(--warning)' }}>
                <div className="card-head">
                  <h3>Possible duplicates</h3>
                </div>
                <div className="card-body small">
                  {data.duplicates.map((d: any) => (
                    <div key={d.id}>
                      {d.name} · {d.phone ?? d.email} · {d.lead_count} lead(s)
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      {editOpen && data ? (
        <CustomerModal
          initial={data}
          onClose={() => setEditOpen(false)}
          onCreated={() => {
            setEditOpen(false);
            reload();
            onChanged();
            toast.push('success', 'Customer updated');
          }}
        />
      ) : null}
    </>
  );
}
