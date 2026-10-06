import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, patch, post, qs, type ListResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format';
import { Badge, EmptyState, ErrorState, Field, Pagination, TableSkeleton, Tabs } from '../ui/atoms';
import { Drawer, Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

const INVOICE_TONES: Record<string, 'gray' | 'blue' | 'green' | 'red' | 'amber'> = {
  DRAFT: 'gray',
  ISSUED: 'blue',
  PAID: 'green',
  VOID: 'red',
};

/** Mirrors the server-side transition table — the server still validates every change. */
const INVOICE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ISSUED', 'VOID'],
  ISSUED: ['PAID', 'VOID'],
  PAID: ['VOID'],
  VOID: [],
};

const STATUS_TABS = ['', 'DRAFT', 'ISSUED', 'PAID', 'VOID'];

export default function Invoices() {
  const { can } = useAuth();
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const { data, loading, error, reload } = useQuery<ListResponse<any>>(
    `/api/invoices${qs({ page, limit, search, status: tab })}`,
    [reloadKey],
  );
  const { data: detail } = useQuery<any>(selectedId ? `/api/invoices/${selectedId}` : null, [reloadKey]);

  const rows = data?.data ?? [];
  const meta = data?.meta as any;
  const totals = meta?.totals ?? { total_amount: 0, paid_amount: 0, balance_due: 0, count: 0 };

  const reloadAll = () => {
    setReloadKey((k) => k + 1);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <div className="sub">Billing documents for bookings and quotations — totals are computed on the server.</div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)} disabled={!can('invoices:create')}>
            + New invoice
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="label">Invoiced</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(totals.total_amount)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Collected</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(totals.paid_amount)}</div>
        </div>
        <div className={`kpi${totals.balance_due > 0 ? ' accent-amber' : ''}`}>
          <div className="label">Outstanding</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCurrency(totals.balance_due)}</div>
        </div>
        <div className="kpi accent-cyan">
          <div className="label">Invoices</div>
          <div className="value">{totals.count ?? 0}</div>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(k) => {
          setTab(k);
          setPage(1);
        }}
        tabs={STATUS_TABS.map((s) => ({ key: s, label: s || 'All' }))}
      />

      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="Search number, customer, booking…"
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
            title="No invoices"
            description="Create an invoice for a booking or a customer."
            action={
              can('invoices:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  + New invoice
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
                    <th>Booking</th>
                    <th>Issued</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="text-right">Total</th>
                    <th className="text-right hide-sm">Paid</th>
                    <th className="text-right hide-sm">Balance</th>
                    <th className="actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((inv) => (
                    <tr key={inv.id} className="clickable" onClick={() => setSelectedId(inv.id)}>
                      <td className="mono">{inv.invoice_number}</td>
                      <td>{inv.customer_name ?? '—'}</td>
                      <td className="mono">{inv.booking_number ?? '—'}</td>
                      <td>{formatDate(inv.issue_date)}</td>
                      <td>{inv.due_date ? formatDate(inv.due_date) : '—'}</td>
                      <td>
                        <Badge color={INVOICE_TONES[inv.status] ?? 'gray'}>{inv.status}</Badge>
                      </td>
                      <td className="text-right">
                        <strong>{formatCurrency(inv.total_amount, inv.currency)}</strong>
                      </td>
                      <td className="text-right hide-sm">{formatCurrency(inv.paid_amount, inv.currency)}</td>
                      <td className="text-right hide-sm" style={inv.balance_due > 0 ? { color: 'var(--danger)' } : undefined}>
                        {formatCurrency(inv.balance_due, inv.currency)}
                      </td>
                      <td className="actions-cell">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(inv.id);
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
        <CreateInvoiceModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            reloadAll();
            setSelectedId(id);
          }}
        />
      ) : null}

      {selectedId && detail?.data ? (
        <Drawer title={detail.data.invoice_number} onClose={() => setSelectedId(null)}>
          <InvoiceDetail invoice={detail.data} onChanged={reloadAll} />
        </Drawer>
      ) : null}
    </>
  );
}

function InvoiceDetail({ invoice, onChanged }: { invoice: any; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const allowed = INVOICE_TRANSITIONS[invoice.status] ?? [];

  const canWrite =
    can('invoices:manage') ||
    (can('invoices:update_own') && invoice.status === 'DRAFT');

  const transition = async (status: string) => {
    if (status === 'VOID') {
      const okConfirm = await confirm({
        title: 'Void invoice?',
        message: 'A void invoice stays in history for accounting.',
        confirmLabel: 'Void invoice',
        danger: true,
      });
      if (!okConfirm) return;
    }
    setBusy(true);
    try {
      await patch(`/api/invoices/${invoice.id}/status`, { status });
      toast.push('success', 'Status updated', `Invoice is now ${status.toLowerCase()}`);
      onChanged();
    } catch (err) {
      toast.push('error', 'Could not update status', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const okConfirm = await confirm({
      title: 'Delete invoice?',
      message: 'The invoice is removed from lists but kept in the audit trail.',
      confirmLabel: 'Delete invoice',
      danger: true,
    });
    if (!okConfirm) return;
    setBusy(true);
    try {
      await del(`/api/invoices/${invoice.id}`);
      toast.push('success', 'Invoice deleted');
      onChanged();
    } catch (err) {
      toast.push('error', 'Could not delete', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const subtotal = invoice.items.reduce(
    (s: number, it: any) => s + Number(it.qty ?? 1) * Number(it.unit_price ?? 0),
    0,
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge color={INVOICE_TONES[invoice.status] ?? 'gray'}>{invoice.status}</Badge>
        {invoice.booking_number ? <span className="small muted">for booking {invoice.booking_number}</span> : null}
        {invoice.quotation_number ? <span className="small muted">from {invoice.quotation_number}</span> : null}
      </div>

      <div className="kpi-grid kpi-3">
        <div className="kpi">
          <div className="label">Total</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(invoice.total_amount, invoice.currency)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Paid</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(invoice.paid_amount, invoice.currency)}</div>
        </div>
        <div className={`kpi${invoice.balance_due > 0 ? ' accent-red' : ''}`}>
          <div className="label">Balance due</div>
          <div className="value" style={{ fontSize: 17 }}>{formatCurrency(invoice.balance_due, invoice.currency)}</div>
        </div>
      </div>

      <div className="stack small" style={{ gap: 7 }}>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Customer</span><span>{invoice.customer_name}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Issued</span><span>{formatDate(invoice.issue_date)}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Due</span><span>{invoice.due_date ? formatDate(invoice.due_date) : '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Worker</span><span>{invoice.worker_name ?? '—'}</span></div>
        <div className="row small"><span className="muted" style={{ width: 100 }}>Created</span><span>{formatDateTime(invoice.created_at)}</span></div>
        {invoice.lead_id ? (
          <div className="row small">
            <span className="muted" style={{ width: 100 }}>Lead</span>
            <Link to={`/leads/${invoice.lead_id}`} className="mono">{invoice.lead_number} →</Link>
          </div>
        ) : null}
        {invoice.notes ? (
          <div className="row small"><span className="muted" style={{ width: 100 }}>Notes</span><span>{invoice.notes}</span></div>
        ) : null}
      </div>

      <div className="divider" />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Unit price</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((it: any, i: number) => (
              <tr key={i}>
                <td>{it.description}</td>
                <td className="text-right">{it.qty ?? 1}</td>
                <td className="text-right">{formatCurrency(it.unit_price, invoice.currency)}</td>
                <td className="text-right">{formatCurrency(Number(it.qty ?? 1) * Number(it.unit_price ?? 0), invoice.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stack small" style={{ gap: 5 }}>
        <div className="row small"><span className="muted">Subtotal</span><span className="right">{formatCurrency(subtotal, invoice.currency)}</span></div>
        <div className="row small"><span className="muted">Tax ({invoice.tax_rate}%)</span><span className="right">{formatCurrency(invoice.tax_amount, invoice.currency)}</span></div>
        <div className="row small" style={{ fontWeight: 700 }}><span>Total</span><span className="right">{formatCurrency(invoice.total_amount, invoice.currency)}</span></div>
      </div>

      <div className="divider" />
      {allowed.length && canWrite ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {allowed.map((s) => (
            <button
              type="button"
              key={s}
              className={`btn btn-sm${s === 'ISSUED' || s === 'PAID' ? ' btn-primary' : ' btn-ghost'}`}
              disabled={busy}
              onClick={() => transition(s)}
            >
              {s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
            </button>
          ))}
          {can('invoices:manage') && invoice.status !== 'VOID' ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={remove}>
              Delete
            </button>
          ) : null}
        </div>
      ) : (
        <div className="small muted">This invoice is closed.</div>
      )}
    </div>
  );
}

function CreateInvoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Array<{ id: number; name: string }>>([]);
  const [bookings, setBookings] = useState<Array<{ id: number; booking_number: string; customer_id: number; currency: string }>>([]);
  const [customerId, setCustomerId] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Array<{ description: string; qty: string; unit_price: string }>>([
    { description: '', qty: '1', unit_price: '' },
  ]);

  const { data: customerData } = useQuery<{ data: any[] }>('/api/customers?limit=100', []);
  const { data: bookingData } = useQuery<{ data: any[] }>('/api/bookings?limit=100', []);

  useEffect(() => {
    if (customerData?.data) {
      setCustomers(customerData.data.map((c) => ({ id: c.id, name: c.name })));
    }
  }, [customerData]);
  useEffect(() => {
    if (bookingData?.data) {
      setBookings(
        bookingData.data.map((b) => ({
          id: b.id,
          booking_number: b.booking_number,
          customer_id: b.customer_id,
          currency: b.currency,
        })),
      );
    }
  }, [bookingData]);

  const selectedBooking = bookings.find((b) => String(b.id) === bookingId);
  const visibleBookings = customerId ? bookings.filter((b) => String(b.customer_id) === customerId) : bookings;

  const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const taxAmount = (subtotal * (Number(taxRate) || 0)) / 100;
  const total = subtotal + taxAmount;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = items
      .filter((it) => it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        qty: Number(it.qty) || 1,
        unit_price: Number(it.unit_price) || 0,
      }));
    if (!customerId) {
      setError('Pick a customer.');
      return;
    }
    if (!clean.length) {
      setError('Add at least one line item.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ data: any }>('/api/invoices', {
        customer_id: Number(customerId),
        booking_id: bookingId ? Number(bookingId) : null,
        issue_date: issueDate,
        due_date: dueDate || null,
        items: clean,
        tax_rate: Number(taxRate) || 0,
        currency: selectedBooking?.currency ?? 'INR',
        notes: notes || null,
      });
      onCreated(res.data.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invoice');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New invoice"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="invoice-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create invoice'}
          </button>
        </>
      }
    >
      <form id="invoice-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <div className="form-grid">
          <Field label="Customer" required>
            <select className="select" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setBookingId(''); }} required>
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Booking (optional)">
            <select className="select" value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
              <option value="">No booking</option>
              {visibleBookings.map((b) => (
                <option key={b.id} value={b.id}>{b.booking_number}</option>
              ))}
            </select>
          </Field>
          <Field label="Issue date" required>
            <input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </Field>
          <Field label="Due date">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>

        <div className="small muted">Line items — subtotal, tax and total are recalculated on the server.</div>
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
                style={{ width: 80 }}
                type="number"
                min={0.01}
                step="any"
                placeholder="Qty"
                value={it.qty}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
              />
              <input
                className="input"
                style={{ width: 140 }}
                type="number"
                min={0}
                step="0.01"
                placeholder="Unit price"
                value={it.unit_price}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))}
              />
              <button type="button" className="btn btn-ghost btn-sm" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setItems([...items, { description: '', qty: '1', unit_price: '' }])}>
            + Add item
          </button>
          <span className="right small">
            Tax % <input className="input" style={{ width: 70, marginLeft: 6 }} type="number" min={0} max={100} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
          </span>
        </div>
        <div className="row small">
          <span className="muted">Subtotal {formatCurrency(subtotal)} · Tax {formatCurrency(taxAmount)}</span>
          <span className="right"><strong>Total {formatCurrency(total)}</strong></span>
        </div>

        <Field label="Notes">
          <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
