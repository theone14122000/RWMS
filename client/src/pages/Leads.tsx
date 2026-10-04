import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, get, post, qs } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMeta } from '../lib/meta';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, todayISODate } from '../lib/format';
import {
  EmptyState,
  ErrorState,
  Field,
  Pagination,
  PriorityBadge,
  StatusBadge,
  TableSkeleton,
} from '../ui/atoms';
import { Modal } from '../ui/overlays';
import { useToast } from '../ui/Toast';

interface LeadRow {
  id: number;
  lead_number: string;
  customer: { id: number; name: string; phone?: string; email?: string } | null;
  source: { id: number; name: string } | null;
  assignee: { id: number; name: string } | null;
  destination: string;
  travel_type?: string;
  trip_type?: string;
  budget?: number;
  currency?: string;
  priority: string;
  status: { code: string; name: string; color: string } | null;
  next_follow_up_date?: string | null;
  next_follow_up_status?: string | null;
  created_at: string;
}

const PERIODS = [
  { value: '', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];

export default function Leads() {
  const { can } = useAuth();
  const { statuses, sources, tripTypes, requirements, priorities } = useMeta();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<number[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const query = useMemo(() => {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    obj.limit = obj.limit ?? 20;
    return obj;
  }, [params]);

  const url = `/api/leads${qs(query)}`;
  const { data, loading, error, reload } = useQuery<{ data: LeadRow[]; meta: any }>(url, [reloadKey]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
    setSelected([]);
  };

  const meta = data?.meta;
  const rows = data?.data ?? [];

  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  const toggleAll = () => {
    setSelected(allSelected ? [] : rows.map((r) => r.id));
  };

  const bulkAssign = async (workerId: number | null, reason?: string) => {
    if (!selected.length) return;
    try {
      const res = await post<{ data: any }>('/api/leads/bulk/assign', {
        lead_ids: selected,
        worker_id: workerId,
        reason: reason || null,
      });
      toast.push('success', 'Assignment updated', `${res.data.assigned} assigned, ${res.data.reassigned} reassigned`);
      setSelected([]);
      setAssignOpen(false);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.push('error', 'Assignment failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{can('leads:read_all') ? 'All leads' : 'My leads'}</h1>
          <div className="sub">
            {meta ? `${meta.total} lead${meta.total === 1 ? '' : 's'} matching current filters` : 'Loading…'}
          </div>
        </div>
        <div className="actions">
          {can('leads:assign') && selected.length > 0 ? (
            <>
              <span className="badge badge-blue" style={{ alignSelf: 'center' }}>
                {selected.length} selected
              </span>
              <button type="button" className="btn" onClick={() => setAssignOpen(true)}>
                Assign selected
              </button>
            </>
          ) : null}
          {can('leads:create') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              + New lead
            </button>
          ) : null}
        </div>
      </div>

      <div className="toolbar">
        <div className="grow input-search">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Search name, phone, email, lead number, destination, worker…"
            defaultValue={params.get('search') ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('search', (e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <select className="select" value={params.get('period') ?? ''} onChange={(e) => setFilter('period', e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select className="select" value={params.get('status') ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select" value={params.get('source') ?? ''} onChange={(e) => setFilter('source', e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select" value={params.get('assigned') ?? ''} onChange={(e) => setFilter('assigned', e.target.value)}>
          <option value="">Assigned &amp; unassigned</option>
          <option value="assigned">Assigned only</option>
          <option value="unassigned">Unassigned only</option>
        </select>
        <select className="select" value={params.get('priority') ?? ''} onChange={(e) => setFilter('priority', e.target.value)}>
          <option value="">All priorities</option>
          {priorities.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={params.get('follow_up_status') ?? ''}
          onChange={(e) => setFilter('follow_up_status', e.target.value)}
        >
          <option value="">Any follow-up status</option>
          {['PENDING', 'TODAY', 'OVERDUE', 'COMPLETED', 'CONVERTED', 'NOT_INTERESTED'].map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <select className="select" value={params.get('sort') ?? 'recent'} onChange={(e) => setFilter('sort', e.target.value)}>
          <option value="recent">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="updated">Recently updated</option>
          <option value="priority">By priority</option>
          <option value="follow_up">By next follow-up</option>
        </select>
        {params.toString() ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setParams(new URLSearchParams(), { replace: true });
              setSelected([]);
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={8} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No leads found"
            description="Adjust your filters or create a new lead to get started."
            action={
              can('leads:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  + New lead
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
                    {can('leads:assign') ? (
                      <th style={{ width: 34 }}>
                        <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                      </th>
                    ) : null}
                    <th>Lead</th>
                    <th>Customer</th>
                    <th>Destination</th>
                    <th className="hide-sm">Trip</th>
                    <th>Status</th>
                    <th className="hide-sm">Priority</th>
                    <th>Assignee</th>
                    <th className="text-right hide-sm">Budget</th>
                    <th>Next follow-up</th>
                    <th className="hide-sm">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((lead) => (
                    <tr key={lead.id}>
                      {can('leads:assign') ? (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.includes(lead.id)}
                            onChange={() =>
                              setSelected((prev) =>
                                prev.includes(lead.id) ? prev.filter((id) => id !== lead.id) : [...prev, lead.id],
                              )
                            }
                            aria-label={`Select ${lead.lead_number}`}
                          />
                        </td>
                      ) : null}
                      <td>
                        <Link to={`/leads/${lead.id}`} className="mono cell-main">
                          {lead.lead_number}
                        </Link>
                        {lead.source ? <div className="cell-sub">{lead.source.name}</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{lead.customer?.name}</div>
                        <div className="cell-sub">{lead.customer?.phone}</div>
                      </td>
                      <td>{lead.destination}</td>
                      <td className="hide-sm">
                        <div className="small">{lead.trip_type ?? '—'}</div>
                        <div className="cell-sub">{lead.travel_type === 'INTERNATIONAL' ? 'Intl' : 'Domestic'}</div>
                      </td>
                      <td>
                        <StatusBadge code={lead.status?.code} name={lead.status?.name} color={lead.status?.color} />
                      </td>
                      <td className="hide-sm">
                        <PriorityBadge priority={lead.priority} />
                      </td>
                      <td>
                        {lead.assignee ? (
                          <span className="row" style={{ gap: 6 }}>
                            <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                              {lead.assignee.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="small">{lead.assignee.name}</span>
                          </span>
                        ) : (
                          <span className="badge badge-amber">Unassigned</span>
                        )}
                      </td>
                      <td className="text-right hide-sm">{formatCurrency(lead.budget, lead.currency)}</td>
                      <td>
                        {lead.next_follow_up_date ? (
                          <div>
                            <div className="small nowrap">{formatDate(lead.next_follow_up_date)}</div>
                            {lead.next_follow_up_status ? (
                              <span
                                className={`badge badge-${
                                  lead.next_follow_up_status === 'OVERDUE'
                                    ? 'red'
                                    : lead.next_follow_up_status === 'TODAY'
                                      ? 'amber'
                                      : 'blue'
                                }`}
                              >
                                {lead.next_follow_up_status.replace(/_/g, ' ')}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="hide-sm muted small nowrap">{formatDate(lead.created_at)}</td>
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
                limit={meta.limit}
                onLimit={(n) => setFilter('limit', String(n))}
                onPage={(p) => setFilter('page', String(p))}
              />
            ) : null}
          </>
        )}
      </div>

      {createOpen ? (
        <CreateLeadModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
          }}
          requirements={requirements}
          tripTypes={tripTypes}
        />
      ) : null}

      {assignOpen ? (
        <BulkAssignModal
          count={selected.length}
          onClose={() => setAssignOpen(false)}
          onAssign={bulkAssign}
        />
      ) : null}
    </>
  );
}

/* ----------------------------- create lead ----------------------------- */

function CreateLeadModal({
  onClose,
  onCreated,
  requirements,
  tripTypes,
}: {
  onClose: () => void;
  onCreated: () => void;
  requirements: string[];
  tripTypes: string[];
}) {
  const { statuses, sources, priorities, currencies } = useMeta();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<any[] | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customer, setCustomer] = useState({ name: '', phone: '', whatsapp: '', email: '', city: '' });

  const { data: customerResults } = useQuery<{ data: any[] }>(
    searchTerm.trim().length >= 2 ? `/api/customers${qs({ search: searchTerm, limit: 6 })}` : null,
  );

  const checkDuplicate = async (fields: { phone?: string; whatsapp?: string; email?: string }) => {
    try {
      const res = await get<{ data: { duplicates: any[]; is_duplicate: boolean } }>(
        `/api/customers/check-duplicate${qs(fields)}`,
      );
      if (res.data.is_duplicate) setDuplicates(res.data.duplicates);
      else setDuplicates(null);
    } catch {
      /* non-blocking */
    }
  };

  const submit = async (e: FormEvent, allowDuplicate = false) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const payload: any = {
        destination: (document.getElementById('f-destination') as HTMLInputElement).value,
        travel_type: (document.getElementById('f-travel_type') as HTMLSelectElement).value,
        trip_type: (document.getElementById('f-trip_type') as HTMLSelectElement).value || null,
        requirements: requirements.filter((_, i) => {
          const el = document.getElementById(`f-req-${i}`) as HTMLInputElement | null;
          return el?.checked;
        }),
        travel_start_date: (document.getElementById('f-start') as HTMLInputElement).value || null,
        travel_end_date: (document.getElementById('f-end') as HTMLInputElement).value || null,
        adults: Number((document.getElementById('f-adults') as HTMLInputElement).value) || 2,
        children: Number((document.getElementById('f-children') as HTMLInputElement).value) || 0,
        budget: (document.getElementById('f-budget') as HTMLInputElement).value
          ? Number((document.getElementById('f-budget') as HTMLInputElement).value)
          : null,
        currency: (document.getElementById('f-currency') as HTMLSelectElement).value,
        priority: (document.getElementById('f-priority') as HTMLSelectElement).value,
        status: (document.getElementById('f-status') as HTMLSelectElement).value,
        source_id: (document.getElementById('f-source') as HTMLSelectElement).value
          ? Number((document.getElementById('f-source') as HTMLSelectElement).value)
          : null,
        notes: (document.getElementById('f-notes') as HTMLTextAreaElement).value || null,
        allow_duplicate: allowDuplicate,
      };

      if (customerId) {
        payload.customer_id = customerId;
      } else {
        payload.customer = {
          name: (document.getElementById('f-cname') as HTMLInputElement).value,
          phone: (document.getElementById('f-cphone') as HTMLInputElement).value || null,
          whatsapp: (document.getElementById('f-cwa') as HTMLInputElement).value || null,
          email: (document.getElementById('f-cemail') as HTMLInputElement).value || null,
          city: (document.getElementById('f-ccity') as HTMLInputElement).value || null,
        };
      }

      await post('/api/leads', payload);
      toast.push('success', 'Lead created');
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const dups = (err.details as any)?.duplicates ?? [];
        setDuplicates(dups);
        setFormError('Possible duplicate customer found. Review matches, then confirm to create anyway.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Failed to create lead');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New lead"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {duplicates && duplicates.length && formError ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={(e) => submit(e, true)}>
              Create anyway
            </button>
          ) : null}
          <button type="submit" form="create-lead-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create lead'}
          </button>
        </>
      }
    >
      <form id="create-lead-form" onSubmit={submit} className="stack" style={{ gap: 16 }}>
        {formError ? (
          <div style={{ background: 'var(--warning-50)', color: '#92400e', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>
            {formError}
            {duplicates && duplicates.length ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {duplicates.map((d) => (
                  <li key={d.id}>
                    {d.name} · {d.phone ?? d.email} · {d.lead_count} lead(s)
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="form-grid">
          <Field label="Search existing customer" hint="Type 2+ characters to reuse a customer">
            <input
              className="input"
              placeholder="Search by name or phone…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </Field>
          <Field label="Customer">
            <select
              className="select"
              value={customerId ?? ''}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">+ New customer</option>
              {(customerResults?.data ?? []).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.phone ?? c.email}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {!customerId ? (
          <div className="form-grid">
            <Field label="Customer name" required>
              <input
                id="f-cname"
                className="input"
                required
                value={customer.name}
                onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                onBlur={() =>
                  checkDuplicate({ phone: customer.phone, whatsapp: customer.whatsapp, email: customer.email })
                }
              />
            </Field>
            <Field label="Phone">
              <input
                id="f-cphone"
                className="input"
                value={customer.phone}
                onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                onBlur={() => checkDuplicate({ phone: customer.phone })}
              />
            </Field>
            <Field label="WhatsApp">
              <input
                id="f-cwa"
                className="input"
                value={customer.whatsapp}
                onChange={(e) => setCustomer({ ...customer, whatsapp: e.target.value })}
                onBlur={() => checkDuplicate({ whatsapp: customer.whatsapp })}
              />
            </Field>
            <Field label="Email">
              <input
                id="f-cemail"
                className="input"
                type="email"
                value={customer.email}
                onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
                onBlur={() => checkDuplicate({ email: customer.email })}
              />
            </Field>
            <Field label="City">
              <input id="f-ccity" className="input" value={customer.city} onChange={(e) => setCustomer({ ...customer, city: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="small muted">Selected existing customer — duplicate check not required.</div>
        )}

        <div className="divider" />

        <div className="form-grid">
          <Field label="Destination" required>
            <input id="f-destination" className="input" required placeholder="e.g. Goa, Dubai, Bali" />
          </Field>
          <Field label="Travel type" required>
            <select id="f-travel_type" className="select" defaultValue="DOMESTIC">
              <option value="DOMESTIC">Domestic</option>
              <option value="INTERNATIONAL">International</option>
            </select>
          </Field>
          <Field label="Trip type">
            <select id="f-trip_type" className="select" defaultValue="">
              <option value="">Select…</option>
              {tripTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lead source">
            <select id="f-source" className="select" defaultValue="">
              <option value="">Unknown</option>
              {sources.filter((s) => s.is_active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start date">
            <input id="f-start" className="input" type="date" defaultValue={todayISODate()} />
          </Field>
          <Field label="End date">
            <input id="f-end" className="input" type="date" />
          </Field>
          <Field label="Adults">
            <input id="f-adults" className="input" type="number" min={1} defaultValue={2} />
          </Field>
          <Field label="Children">
            <input id="f-children" className="input" type="number" min={0} defaultValue={0} />
          </Field>
          <Field label="Budget">
            <input id="f-budget" className="input" type="number" min={0} placeholder="INR" />
          </Field>
          <Field label="Currency">
            <select id="f-currency" className="select" defaultValue="INR">
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select id="f-priority" className="select" defaultValue="MEDIUM">
              {priorities.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select id="f-status" className="select" defaultValue="NEW">
              {statuses.filter((s) => s.is_active).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Requirements">
          <div className="row" style={{ gap: 8 }}>
            {requirements.map((r, i) => (
              <label key={r} className="check-row" style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '4px 10px', cursor: 'pointer' }}>
                <input type="checkbox" id={`f-req-${i}`} />
                {r}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Notes">
          <textarea id="f-notes" className="textarea" placeholder="Anything the team should know…" />
        </Field>
      </form>
    </Modal>
  );
}

/* ----------------------------- bulk assign ----------------------------- */

function BulkAssignModal({
  count,
  onClose,
  onAssign,
}: {
  count: number;
  onClose: () => void;
  onAssign: (workerId: number | null, reason?: string) => void;
}) {
  const { data: workers } = useQuery<{ data: any[] }>('/api/users?status=ACTIVE&limit=100');
  const [workerId, setWorkerId] = useState<number | ''>('');
  const [reason, setReason] = useState('');

  return (
    <Modal
      title={`Assign ${count} lead${count === 1 ? '' : 's'}`}
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
            disabled={!workerId}
            onClick={() => onAssign(Number(workerId), reason)}
          >
            Assign
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Assign to worker" required>
          <select className="select" value={workerId} onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Select worker…</option>
            {(workers?.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.open_lead_count} open leads
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason (optional)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Goa specialist" />
        </Field>
        <div className="small muted">
          Assignment history is preserved — reassigning never overwrites who owned the lead before.
        </div>
      </div>
    </Modal>
  );
}
