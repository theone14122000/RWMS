import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, post, qs, type ListResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format';
import { Badge, EmptyState, ErrorState, Field, Pagination, TableSkeleton, Tabs } from '../ui/atoms';
import { Drawer, Modal, useConfirm } from '../ui/overlays';
import { LeadPicker } from '../ui/pickers';
import { useToast } from '../ui/Toast';

const QUOTATION_TONES: Record<string, 'gray' | 'blue' | 'cyan' | 'purple' | 'green' | 'red' | 'amber'> = {
  DRAFT: 'gray',
  SENT: 'blue',
  VIEWED: 'cyan',
  NEGOTIATION: 'purple',
  ACCEPTED: 'green',
  REJECTED: 'red',
  EXPIRED: 'red',
  CANCELLED: 'gray',
};

/** Mirrors the server-side transition table — the server still validates every change. */
const QUOTATION_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['VIEWED', 'NEGOTIATION', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  VIEWED: ['NEGOTIATION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  NEGOTIATION: ['SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['CANCELLED'],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const STATUS_TABS = ['', 'DRAFT', 'SENT', 'VIEWED', 'NEGOTIATION', 'ACCEPTED', 'REJECTED'];

export default function Quotations() {
  const { can } = useAuth();
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data: stats } = useQuery<any>('/api/quotations/stats/summary', [reloadKey]);
  const { data, loading, error, reload } = useQuery<ListResponse<any>>(
    `/api/quotations${qs({ page, limit, search, status: tab })}`,
    [reloadKey],
  );
  const { data: detail, reload: reloadDetail } = useQuery<any>(selectedId ? `/api/quotations/${selectedId}` : null, [reloadKey]);

  const rows = data?.data ?? [];
  const meta = data?.meta;
  const byStatus = stats?.data?.by_status ?? {};
  const openCount = ['DRAFT', 'SENT', 'VIEWED', 'NEGOTIATION'].reduce((s, k) => s + (byStatus[k]?.count ?? 0), 0);
  const openAmount = ['DRAFT', 'SENT', 'VIEWED', 'NEGOTIATION'].reduce((s, k) => s + (byStatus[k]?.amount ?? 0), 0);
  const acceptedAmount = byStatus.ACCEPTED?.amount ?? 0;

  const reloadAll = () => {
    setReloadKey((k) => k + 1);
    reload();
    reloadDetail();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <div className="sub">Draft → send → negotiate → accept. Accepted quotations convert into bookings.</div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)} disabled={!can('quotations:create')}>
            + New quotation
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi accent-cyan">
          <div className="label">Open quotations</div>
          <div className="value">{openCount}</div>
        </div>
        <div className="kpi">
          <div className="label">Open value</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(openAmount)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Accepted value</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(acceptedAmount)}</div>
        </div>
        <div className={`kpi${(stats?.data?.expiring_in_7_days ?? 0) > 0 ? ' accent-amber' : ''}`}>
          <div className="label">Expiring in 7 days</div>
          <div className="value">{stats?.data?.expiring_in_7_days ?? 0}</div>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(k) => {
          setTab(k);
          setPage(1);
        }}
        tabs={STATUS_TABS.map((s) => ({ key: s, label: s || 'All', ...(byStatus[s] ? { count: byStatus[s].count } : {}) }))}
      />

      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="Search number, customer, lead…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !rows.length ? (
          <EmptyState
            title="No quotations"
            description="Create a quotation from a lead to start the sales flow."
            action={
              can('quotations:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  + New quotation
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
                    <th>Number</th>
                    <th>Lead</th>
                    <th>Customer</th>
                    <th>Destination</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                    <th className="hide-sm">Valid until</th>
                    <th className="hide-sm">Created</th>
                    <th className="actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((q) => (
                    <tr key={q.id} className="clickable" onClick={() => setSelectedId(q.id)}>
                      <td className="mono">{q.quotation_number}</td>
                      <td>
                        {q.lead_id ? (
                          <Link to={`/leads/${q.lead_id}`} className="mono" onClick={(e) => e.stopPropagation()}>
                            {q.lead_number}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{q.customer_name ?? '—'}</td>
                      <td>{q.destination ?? '—'}</td>
                      <td>
                        <Badge color={QUOTATION_TONES[q.status] ?? 'gray'}>{q.status}</Badge>
                      </td>
                      <td className="text-right">
                        <strong>{formatCurrency(q.total_amount, q.currency)}</strong>
                      </td>
                      <td className="small muted hide-sm">{formatDate(q.valid_until)}</td>
                      <td className="small muted hide-sm">{formatDate(q.created_at)}</td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(q.id);
                          }}
                        >
                          Open
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

      {createOpen ? (
        <CreateQuotationModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            reloadAll();
            setSelectedId(id);
          }}
        />
      ) : null}

      {selectedId && detail?.data ? (
        <Drawer title={detail.data.quotation_number} onClose={() => setSelectedId(null)}>
          <QuotationDetail quotation={detail.data} onChanged={reloadAll} />
        </Drawer>
      ) : null}
    </>
  );
}

function QuotationDetail({ quotation, onChanged }: { quotation: any; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const allowed = QUOTATION_TRANSITIONS[quotation.status] ?? [];
  const closed = ['ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(quotation.status);
  const canEdit = !closed || can('quotations:manage');

  const transition = async (status: string) => {
    if (status === 'CANCELLED' || status === 'REJECTED') {
      const okConfirm = await confirm({
        title: `${status === 'CANCELLED' ? 'Cancel' : 'Reject'} quotation?`,
        message: 'The quotation moves to a closed state. You can still view it afterwards.',
        confirmLabel: status === 'CANCELLED' ? 'Cancel quotation' : 'Reject',
        danger: true,
      });
      if (!okConfirm) return;
    }
    setBusy(true);
    try {
      await post(`/api/quotations/${quotation.id}/status`, { status });
      toast.push('success', 'Status updated', `Quotation is now ${status.toLowerCase()}`);
      onChanged();
    } catch (err) {
      toast.push('error', 'Could not update status', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const convert = async () => {
    const okConfirm = await confirm({
      title: 'Convert to booking?',
      message: 'A confirmed booking will be created and the lead marked converted.',
      confirmLabel: 'Convert',
    });
    if (!okConfirm) return;
    setBusy(true);
    try {
      const res = await post<{ data: any }>(`/api/quotations/${quotation.id}/convert`, {});
      toast.push('success', 'Booking created', res.data?.booking_number);
      onChanged();
    } catch (err) {
      toast.push('error', 'Conversion failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge color={QUOTATION_TONES[quotation.status] ?? 'gray'}>{quotation.status}</Badge>
        {quotation.lead_id ? (
          <Link to={`/leads/${quotation.lead_id}`} className="small mono">
            {quotation.lead_number} →
          </Link>
        ) : null}
      </div>

      <div className="kpi-grid kpi-2">
        <div className="kpi accent-green">
          <div className="label">Total</div>
          <div className="value" style={{ fontSize: 19 }}>{formatCurrency(quotation.total_amount, quotation.currency)}</div>
        </div>
        <div className="kpi">
          <div className="label">Valid until</div>
          <div className="value" style={{ fontSize: 19 }}>{formatDate(quotation.valid_until)}</div>
        </div>
      </div>

      <div className="stack small" style={{ gap: 7 }}>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Customer</span><span>{quotation.customer_name} · {quotation.customer_phone ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Destination</span><span>{quotation.destination ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Travel</span><span>{formatDate(quotation.travel_start_date)} → {formatDate(quotation.travel_end_date)}{quotation.travelers ? ` · ${quotation.travelers} traveller(s)` : ''}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Worker</span><span>{quotation.worker_name ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Created</span><span>{formatDateTime(quotation.created_at)}{quotation.created_by_name ? ` by ${quotation.created_by_name}` : ''}</span></div>
      </div>

      <div className="divider" />
      <div className="small muted">Line items</div>
      {!quotation.items?.length ? (
        <div className="small muted">No line items.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Unit</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {quotation.items.map((it: any, i: number) => (
                <tr key={i}>
                  <td>{it.description}</td>
                  <td className="text-right">{it.quantity}</td>
                  <td className="text-right">{formatCurrency(it.unit_price, quotation.currency)}</td>
                  <td className="text-right">{formatCurrency(it.amount ?? it.quantity * it.unit_price, quotation.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {quotation.inclusions?.length || quotation.exclusions?.length ? (
        <div className="stack small" style={{ gap: 8 }}>
          {quotation.inclusions?.length ? (
            <div className="row small" style={{ gap: 7, flexWrap: 'wrap' }}>
              <span className="muted">Inclusions:</span>
              {quotation.inclusions.map((r: string) => (
                <Badge key={r} color="green">{r}</Badge>
              ))}
            </div>
          ) : null}
          {quotation.exclusions?.length ? (
            <div className="row small" style={{ gap: 7, flexWrap: 'wrap' }}>
              <span className="muted">Exclusions:</span>
              {quotation.exclusions.map((r: string) => (
                <Badge key={r} color="red">{r}</Badge>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {quotation.notes ? (
        <>
          <div className="divider" />
          <div className="small muted">Notes</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{quotation.notes}</div>
        </>
      ) : null}

      {quotation.status_history?.length ? (
        <>
          <div className="divider" />
          <div className="small muted">History</div>
          <div className="stack" style={{ gap: 6 }}>
            {quotation.status_history.map((h: any, i: number) => (
              <div key={i} className="row small">
                <Badge color="outline">{h.from ?? 'NEW'} → {h.to}</Badge>
                <span className="muted">{h.actor_name ?? h.by_name ?? ''} {formatDateTime(h.at ?? h.changed_at)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="divider" />
      <div className="stack" style={{ gap: 8 }}>
        {quotation.status === 'ACCEPTED' && can('bookings:create') ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={convert}>
            Convert to booking →
          </button>
        ) : null}
        {allowed.length && canEdit ? (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {allowed.map((s) => (
              <button
                type="button"
                key={s}
                className={`btn btn-sm${s === 'ACCEPTED' ? ' btn-primary' : s === 'REJECTED' || s === 'CANCELLED' ? ' btn-ghost' : ''}`}
                disabled={busy}
                onClick={() => transition(s)}
              >
                {s === 'SENT' && quotation.status === 'NEGOTIATION' ? 'Re-send' : s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
              </button>
            ))}
          </div>
        ) : (
          <div className="small muted">
            {closed && !canEdit ? 'This quotation is closed and read-only for you.' : 'No further transitions available.'}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateQuotationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<any | null>(null);
  const [items, setItems] = useState<Array<{ description: string; quantity: string; unit_price: string }>>([
    { description: '', quantity: '1', unit_price: '' },
  ]);

  const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead) {
      setError('Pick a lead first.');
      return;
    }
    const clean = items
      .filter((it) => it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        quantity: Number(it.quantity) || 1,
        unit_price: Number(it.unit_price) || 0,
      }));
    if (!clean.length) {
      setError('Add at least one line item.');
      return;
    }
    setBusy(true);
    setError(null);
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await post<{ data: any }>('/api/quotations', {
        lead_id: lead.id,
        destination: (fd.get('destination') as string) || lead.destination || null,
        travel_start_date: (fd.get('travel_start_date') as string) || null,
        travel_end_date: (fd.get('travel_end_date') as string) || null,
        travelers: fd.get('travelers') ? Number(fd.get('travelers')) : null,
        items: clean,
        inclusions: ((fd.get('inclusions') as string) || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        exclusions: ((fd.get('exclusions') as string) || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        notes: (fd.get('notes') as string) || null,
        valid_until: (fd.get('valid_until') as string) || null,
      });
      onCreated(res.data.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create quotation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New quotation"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="quotation-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : `Create quotation · ${formatCurrency(total)}`}
          </button>
        </>
      }
    >
      <form id="quotation-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <LeadPicker value={lead} onChange={setLead} />
        <div className="form-grid">
          <Field label="Destination">
            <input className="input" name="destination" defaultValue={lead?.destination ?? ''} placeholder="Defaults to the lead destination" />
          </Field>
          <Field label="Travellers">
            <input className="input" name="travelers" type="number" min={1} max={999} />
          </Field>
          <Field label="Travel start">
            <input className="input" name="travel_start_date" type="date" />
          </Field>
          <Field label="Travel end">
            <input className="input" name="travel_end_date" type="date" />
          </Field>
          <Field label="Valid until">
            <input className="input" name="valid_until" type="date" />
          </Field>
        </div>

        <div className="small muted">Line items — the total is always recomputed by the server.</div>
        <div className="stack" style={{ gap: 8 }}>
          {items.map((it, i) => (
            <div key={i} className="row" style={{ gap: 8 }}>
              <input
                className="input"
                style={{ flex: 2 }}
                placeholder="Description"
                value={it.description}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
              />
              <input
                className="input"
                style={{ width: 90 }}
                type="number"
                min={0}
                placeholder="Qty"
                value={it.quantity}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              />
              <input
                className="input"
                style={{ width: 130 }}
                type="number"
                min={0}
                placeholder="Unit price"
                value={it.unit_price}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={items.length === 1}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setItems([...items, { description: '', quantity: '1', unit_price: '' }])}
          >
            + Add item
          </button>
          <span className="right small">
            Total: <strong>{formatCurrency(total)}</strong>
          </span>
        </div>

        <div className="form-grid">
          <Field label="Inclusions" hint="Comma separated">
            <input className="input" name="inclusions" placeholder="Hotel, Breakfast, Transfers" />
          </Field>
          <Field label="Exclusions" hint="Comma separated">
            <input className="input" name="exclusions" placeholder="Flights, Visa" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" name="notes" rows={2} />
        </Field>
      </form>
    </Modal>
  );
}
