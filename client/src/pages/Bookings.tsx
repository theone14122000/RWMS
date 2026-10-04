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

const BOOKING_TONES: Record<string, 'gray' | 'blue' | 'cyan' | 'green' | 'red' | 'amber'> = {
  PENDING: 'amber',
  CONFIRMED: 'blue',
  IN_PROGRESS: 'cyan',
  COMPLETED: 'green',
  CANCELLED: 'red',
};

const PAYMENT_TONES: Record<string, 'green' | 'amber' | 'red'> = {
  PAID: 'green',
  PARTIAL: 'amber',
  UNPAID: 'red',
};

/** Mirrors the server-side transition table — the server still validates every change. */
const BOOKING_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_TABS = ['', 'PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

export default function Bookings() {
  const { can } = useAuth();
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data: stats } = useQuery<any>('/api/bookings/stats/summary', [reloadKey]);
  const { data, loading, error, reload } = useQuery<ListResponse<any>>(
    `/api/bookings${qs({ page, limit, search, status: tab })}`,
    [reloadKey],
  );
  const { data: detail, reload: reloadDetail } = useQuery<any>(selectedId ? `/api/bookings/${selectedId}` : null, [reloadKey]);

  const rows = data?.data ?? [];
  const meta = data?.meta;
  const byStatus = stats?.data?.by_status ?? {};
  const payment = stats?.data?.payment ?? {};

  const activeCount = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'].reduce((s, k) => s + (byStatus[k]?.count ?? 0), 0);
  const bookedAmount = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].reduce((s, k) => s + (byStatus[k]?.amount ?? 0), 0);
  const collectedAmount = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].reduce((s, k) => s + (byStatus[k]?.paid ?? 0), 0);

  const reloadAll = () => {
    setReloadKey((k) => k + 1);
    reload();
    reloadDetail();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <div className="sub">Confirmed trips with services, payments and balances — converted from quotations.</div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)} disabled={!can('bookings:create')}>
            + New booking
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi accent-cyan">
          <div className="label">Active bookings</div>
          <div className="value">{activeCount}</div>
        </div>
        <div className="kpi">
          <div className="label">Booked value</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(bookedAmount)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Collected</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(collectedAmount)}</div>
        </div>
        <div className={`kpi${payment.unpaid > 0 ? ' accent-amber' : ''}`}>
          <div className="label">Unpaid / partial</div>
          <div className="value">{payment.unpaid ?? 0} / {payment.partial ?? 0}</div>
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
            title="No bookings"
            description="Convert an accepted quotation or create a booking directly."
            action={
              can('bookings:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  + New booking
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
                    <th>Customer</th>
                    <th>Destination</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right hide-sm">Balance</th>
                    <th className="actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id} className="clickable" onClick={() => setSelectedId(b.id)}>
                      <td className="mono">{b.booking_number}</td>
                      <td>{b.customer_name ?? '—'}</td>
                      <td>
                        {b.destination ?? '—'}{' '}
                        {b.lead_id ? (
                          <Link to={`/leads/${b.lead_id}`} className="mono small" onClick={(e) => e.stopPropagation()}>
                            ({b.lead_number})
                          </Link>
                        ) : null}
                      </td>
                      <td>
                        <Badge color={BOOKING_TONES[b.status] ?? 'gray'}>{b.status.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td>
                        <Badge color={PAYMENT_TONES[b.payment_status] ?? 'gray'}>{b.payment_status}</Badge>
                      </td>
                      <td className="text-right"><strong>{formatCurrency(b.total_amount, b.currency)}</strong></td>
                      <td className="text-right">{formatCurrency(b.paid_amount, b.currency)}</td>
                      <td className="text-right hide-sm" style={b.balance_due > 0 ? { color: 'var(--danger)' } : undefined}>
                        {formatCurrency(b.balance_due, b.currency)}
                      </td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(b.id);
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
        <CreateBookingModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            reloadAll();
            setSelectedId(id);
          }}
        />
      ) : null}

      {selectedId && detail?.data ? (
        <Drawer title={detail.data.booking_number} onClose={() => setSelectedId(null)}>
          <BookingDetail booking={detail.data} onChanged={reloadAll} />
        </Drawer>
      ) : null}
    </>
  );
}

function BookingDetail({ booking, onChanged }: { booking: any; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const allowed = BOOKING_TRANSITIONS[booking.status] ?? [];

  const { data: payments, reload: reloadPayments } = useQuery<{ data: any[] }>(`/api/bookings/${booking.id}/payments`);

  const transition = async (status: string) => {
    if (status === 'CANCELLED') {
      const okConfirm = await confirm({
        title: 'Cancel booking?',
        message: 'Payments already recorded stay in history.',
        confirmLabel: 'Cancel booking',
        danger: true,
      });
      if (!okConfirm) return;
    }
    setBusy(true);
    try {
      await post(`/api/bookings/${booking.id}/status`, { status });
      toast.push('success', 'Status updated', `Booking is now ${status.toLowerCase().replace('_', ' ')}`);
      onChanged();
    } catch (err) {
      toast.push('error', 'Could not update status', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const openPayment = booking.status !== 'CANCELLED';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge color={BOOKING_TONES[booking.status] ?? 'gray'}>{booking.status.replace(/_/g, ' ')}</Badge>
        <Badge color={PAYMENT_TONES[booking.payment_status] ?? 'gray'}>{booking.payment_status}</Badge>
        {booking.quotation_id ? (
          <span className="small muted">from {booking.quotation_number}</span>
        ) : null}
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className="kpi">
          <div className="label">Total</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(booking.total_amount, booking.currency)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Paid</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(booking.paid_amount, booking.currency)}</div>
        </div>
        <div className={`kpi${booking.balance_due > 0 ? ' accent-red' : ''}`}>
          <div className="label">Balance due</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(booking.balance_due, booking.currency)}</div>
        </div>
      </div>

      <div className="stack small" style={{ gap: 7 }}>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Customer</span><span>{booking.customer_name} · {booking.customer_phone ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Destination</span><span>{booking.destination ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Travel</span><span>{formatDate(booking.travel_start_date)} → {formatDate(booking.travel_end_date)}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Worker</span><span>{booking.worker_name ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Booked</span><span>{formatDateTime(booking.booked_at ?? booking.created_at)}</span></div>
        {booking.lead_id ? (
          <div className="row small">
            <span className="muted" style={{ width: 100 }}>Lead</span>
            <Link to={`/leads/${booking.lead_id}`} className="mono">{booking.lead_number} →</Link>
          </div>
        ) : null}
      </div>

      {booking.services?.length ? (
        <>
          <div className="divider" />
          <div className="small muted">Services</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {booking.services.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>{s.name}</td>
                    <td className="text-right">{formatCurrency(s.amount, booking.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="divider" />
      <div className="row">
        <div className="small muted">Payments</div>
        {openPayment && can('bookings:update') ? (
          <button type="button" className="btn btn-sm right" onClick={() => setPayOpen(true)}>
            + Record payment
          </button>
        ) : null}
      </div>
      {!payments?.data?.length ? (
        <div className="small muted">No payments recorded yet.</div>
      ) : (
        <div className="stack" style={{ gap: 7 }}>
          {payments.data.map((p: any) => (
            <div key={p.id} className="row small" style={{ gap: 8 }}>
              <Badge color={p.status === 'CONFIRMED' ? 'green' : 'outline'}>{p.status}</Badge>
              <strong>{formatCurrency(p.amount, p.currency ?? booking.currency)}</strong>
              <span className="muted">{p.method ?? '—'}{p.reference ? ` · ${p.reference}` : ''}</span>
              <span className="muted right">{formatDate(p.paid_at ?? p.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />
      {allowed.length ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {allowed.map((s) => (
            <button
              type="button"
              key={s}
              className={`btn btn-sm${s === 'CONFIRMED' || s === 'COMPLETED' ? ' btn-primary' : s === 'CANCELLED' ? ' btn-ghost' : ''}`}
              disabled={busy}
              onClick={() => transition(s)}
            >
              {s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
            </button>
          ))}
        </div>
      ) : (
        <div className="small muted">This booking is closed.</div>
      )}

      {payOpen ? (
        <RecordPaymentModal
          booking={booking}
          onClose={() => setPayOpen(false)}
          onSaved={() => {
            setPayOpen(false);
            reloadPayments();
            onChanged();
            toast.push('success', 'Payment recorded');
          }}
        />
      ) : null}
    </div>
  );
}

function RecordPaymentModal({ booking, onClose, onSaved }: { booking: any; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await post(`/api/bookings/${booking.id}/payments`, {
        amount: Number(fd.get('amount')),
        method: (fd.get('method') as string) || null,
        reference: (fd.get('reference') as string) || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record payment"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="payment-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <div className="small muted">
          Balance due: <strong>{formatCurrency(booking.balance_due, booking.currency)}</strong>
        </div>
        <Field label="Amount" required>
          <input className="input" name="amount" type="number" min={1} step="0.01" max={booking.balance_due || undefined} required defaultValue={booking.balance_due > 0 ? booking.balance_due : ''} />
        </Field>
        <Field label="Method">
          <select className="select" name="method" defaultValue="Cash">
            <option>Cash</option>
            <option>UPI</option>
            <option>Bank transfer</option>
            <option>Card</option>
            <option>Cheque</option>
          </select>
        </Field>
        <Field label="Reference">
          <input className="input" name="reference" placeholder="Transaction id / cheque no." maxLength={120} />
        </Field>
      </form>
    </Modal>
  );
}

function CreateBookingModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<any | null>(null);
  const [services, setServices] = useState<Array<{ name: string; amount: string }>>([{ name: '', amount: '' }]);

  const total = services.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lead) {
      setError('Pick a lead first.');
      return;
    }
    const clean = services
      .filter((it) => it.name.trim())
      .map((it) => ({ name: it.name.trim(), amount: Number(it.amount) || 0 }));
    setBusy(true);
    setError(null);
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const res = await post<{ data: any }>('/api/bookings', {
        lead_id: lead.id,
        destination: (fd.get('destination') as string) || lead.destination || null,
        travel_start_date: (fd.get('travel_start_date') as string) || null,
        travel_end_date: (fd.get('travel_end_date') as string) || null,
        services: clean,
        total_amount: clean.length ? total : Number(fd.get('total_amount')) || 0,
        notes: (fd.get('notes') as string) || null,
      });
      onCreated(res.data.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create booking');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New booking"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="booking-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create booking'}
          </button>
        </>
      }
    >
      <form id="booking-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <LeadPicker value={lead} onChange={setLead} />
        <div className="form-grid">
          <Field label="Destination">
            <input className="input" name="destination" defaultValue={lead?.destination ?? ''} />
          </Field>
          <Field label="Travel start">
            <input className="input" name="travel_start_date" type="date" />
          </Field>
          <Field label="Travel end">
            <input className="input" name="travel_end_date" type="date" />
          </Field>
        </div>

        <div className="small muted">Services (optional — leave empty to set a flat total below).</div>
        <div className="stack" style={{ gap: 8 }}>
          {services.map((it, i) => (
            <div key={i} className="row" style={{ gap: 8 }}>
              <input
                className="input"
                style={{ flex: 2 }}
                placeholder="Service name"
                value={it.name}
                onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className="input"
                style={{ width: 140 }}
                type="number"
                min={0}
                placeholder="Amount"
                value={it.amount}
                onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <button type="button" className="btn btn-ghost btn-sm" disabled={services.length === 1} onClick={() => setServices(services.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setServices([...services, { name: '', amount: '' }])}>
            + Add service
          </button>
          <span className="right small">
            Total: <strong>{formatCurrency(total)}</strong>
          </span>
        </div>

        <Field label="Notes">
          <textarea className="textarea" name="notes" rows={2} />
        </Field>
      </form>
    </Modal>
  );
}
