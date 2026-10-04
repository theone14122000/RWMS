import { useState } from 'react';
import { ApiError, post, qs } from '../api/client';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime, formatDuration } from '../lib/format';
import { Badge, EmptyState, ErrorState, Field, TableSkeleton, Tabs } from '../ui/atoms';
import { Drawer } from '../ui/overlays';
import { useToast } from '../ui/Toast';

const PERIODS = [
  { value: 'month', label: 'This month' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
];

interface Metric {
  label: string;
  value: string | number;
  accent?: 'cyan' | 'green' | 'amber' | 'red';
}

function metricCards(m: any): Metric[] {
  if (!m) return [];
  return [
    { label: 'Leads', value: m.leads },
    { label: 'Converted', value: m.leads_converted, accent: 'green' },
    {
      label: 'Conversion',
      value: m.leads > 0 ? `${Math.round((m.leads_converted / m.leads) * 100)}%` : '—',
    },
    { label: 'Follow-ups done', value: `${m.follow_ups_completed} / ${m.follow_ups_due}` },
    { label: 'Overdue', value: m.follow_ups_overdue, accent: m.follow_ups_overdue > 0 ? 'red' : undefined },
    { label: 'Calls', value: m.calls, accent: 'cyan' },
    { label: 'Connected', value: m.calls_connected, accent: 'cyan' },
    { label: 'Talk time', value: formatDuration(m.call_seconds) },
    { label: 'Quotations', value: `${m.quotations_accepted} / ${m.quotations}` },
    { label: 'Bookings', value: m.bookings, accent: 'green' },
    { label: 'Booking value', value: formatCurrency(m.booking_amount) },
    { label: 'Collected', value: formatCurrency(m.booking_paid), accent: 'green' },
  ];
}

export default function Analytics() {
  const [tab, setTab] = useState('overview');
  const [period, setPeriod] = useState('month');
  const [selectedWorker, setSelectedWorker] = useState<number | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <div className="sub">Pipeline trends and honest worker performance — activity and outcomes, never a single score.</div>
        </div>
        <div className="actions">
          <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(setTab as any)}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'workers', label: 'Workers' },
        ]}
      />

      {tab === 'overview' ? <Overview period={period} /> : null}
      {tab === 'workers' ? <Workers period={period} onSelect={setSelectedWorker} /> : null}

      {selectedWorker ? (
        <Drawer title="Worker detail" onClose={() => setSelectedWorker(null)}>
          <WorkerDetail id={selectedWorker} period={period} />
        </Drawer>
      ) : null}
    </>
  );
}

function Overview({ period }: { period: string }) {
  const { data, loading, error, reload } = useQuery<any>(`/api/analytics/overview${qs({ period })}`);
  const d = data?.data;

  if (loading) return <div className="card"><TableSkeleton rows={8} /></div>;
  if (error) return <div className="card"><ErrorState message={error} onRetry={reload} /></div>;
  if (!d) return null;

  const sum = (rows: any[] | undefined, key: string) => (rows ?? []).reduce((s, r) => s + Number(r[key] ?? 0), 0);
  const totalCalls = sum(d.calls, 'total');
  const connectedCalls = sum(d.calls, 'connected');
  const talkSeconds = sum(d.calls, 'seconds');
  const leadsCreated = sum(d.leads_created, 'count');
  const leadsWon = sum(d.leads_won, 'count');
  const fuDue = sum(d.follow_ups, 'due');
  const fuDone = sum(d.follow_ups, 'completed');
  const bookingAmount = sum(d.bookings, 'amount');
  const bookingPaid = sum(d.bookings, 'paid');
  const maxBucket = Math.max(1, ...(d.leads_created ?? []).map((r: any) => r.count));

  return (
    <div className="stack">
      <div className="kpi-grid">
        <div className="kpi accent-cyan">
          <div className="label">Leads created</div>
          <div className="value">{leadsCreated}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Converted</div>
          <div className="value">{leadsWon}</div>
        </div>
        <div className="kpi">
          <div className="label">Follow-ups done</div>
          <div className="value">{fuDone} / {fuDue}</div>
        </div>
        <div className="kpi accent-cyan">
          <div className="label">Calls</div>
          <div className="value">{totalCalls}</div>
        </div>
        <div className="kpi">
          <div className="label">Connect rate</div>
          <div className="value">{totalCalls ? Math.round((connectedCalls / totalCalls) * 100) : 0}%</div>
        </div>
        <div className="kpi">
          <div className="label">Talk time</div>
          <div className="value" style={{ fontSize: 19 }}>{formatDuration(talkSeconds)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Booking value</div>
          <div className="value" style={{ fontSize: 19 }}>{formatCurrency(bookingAmount)}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Collected</div>
          <div className="value" style={{ fontSize: 19 }}>{formatCurrency(bookingPaid)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Leads created per bucket</h3>
          <span className="right small muted">
            {formatDate(d.period.from)} → {formatDate(d.period.to)} · {d.period.granularity}
          </span>
        </div>
        <div className="card-body">
          {!d.leads_created?.length ? (
            <EmptyState title="No leads in this period" />
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {d.leads_created.map((r: any) => (
                <div key={r.bucket} className="row" style={{ gap: 10 }}>
                  <span className="mono small" style={{ width: 76 }}>{r.bucket}</span>
                  <div style={{ flex: 1, background: 'var(--surface-3)', borderRadius: 5, height: 16, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.round((r.count / maxBucket) * 100)}%`,
                        background: 'var(--primary)',
                        height: '100%',
                        borderRadius: 5,
                      }}
                    />
                  </div>
                  <span className="small mono" style={{ width: 34, textAlign: 'right' }}>{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <div className="card-head"><h3>Calls per bucket</h3></div>
          <div className="card-body stack" style={{ gap: 7 }}>
            {!d.calls?.length ? (
              <div className="small muted">No calls in this period.</div>
            ) : (
              d.calls.map((r: any) => (
                <div key={r.bucket} className="row small">
                  <span className="mono" style={{ width: 76 }}>{r.bucket}</span>
                  <span style={{ width: 70 }}>{r.total} total</span>
                  <span className="muted">{r.connected} connected</span>
                  <span className="muted right">{formatDuration(r.seconds)}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Bookings per bucket</h3></div>
          <div className="card-body stack" style={{ gap: 7 }}>
            {!d.bookings?.length ? (
              <div className="small muted">No bookings in this period.</div>
            ) : (
              d.bookings.map((r: any) => (
                <div key={r.bucket} className="row small">
                  <span className="mono" style={{ width: 76 }}>{r.bucket}</span>
                  <span style={{ width: 40 }}>{r.count}</span>
                  <span>{formatCurrency(r.amount)}</span>
                  <span className="muted right">{formatCurrency(r.paid)} paid</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Workers({ period, onSelect }: { period: string; onSelect: (id: number) => void }) {
  const { data, loading, error, reload } = useQuery<any>(`/api/analytics/workers${qs({ period })}`);
  const rows = data?.data?.workers ?? [];

  if (loading) return <div className="card"><TableSkeleton rows={6} /></div>;
  if (error) return <div className="card"><ErrorState message={error} onRetry={reload} /></div>;

  return (
    <div className="card">
      {!rows.length ? (
        <EmptyState title="No workers" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Worker</th>
                <th className="text-right">Leads</th>
                <th className="text-right hide-sm">Converted</th>
                <th className="text-right">FU done</th>
                <th className="text-right hide-sm">Overdue</th>
                <th className="text-right">Calls</th>
                <th className="text-right hide-sm">Connected</th>
                <th className="text-right hide-sm">Talk time</th>
                <th className="text-right hide-sm">Quotes</th>
                <th className="text-right">Bookings</th>
                <th className="text-right hide-sm">Value</th>
                <th className="actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w: any) => (
                <tr key={w.id} className="clickable" onClick={() => onSelect(w.id)}>
                  <td className="cell-main">
                    {w.name}
                    {w.status !== 'ACTIVE' ? <Badge color="gray">{w.status}</Badge> : null}
                  </td>
                  <td className="text-right">{w.leads}</td>
                  <td className="text-right hide-sm">{w.leads_converted}</td>
                  <td className="text-right">{w.follow_ups_completed}/{w.follow_ups_due}</td>
                  <td className="text-right hide-sm" style={w.follow_ups_overdue ? { color: 'var(--danger)' } : undefined}>
                    {w.follow_ups_overdue}
                  </td>
                  <td className="text-right">{w.calls}</td>
                  <td className="text-right hide-sm">{w.calls_connected}</td>
                  <td className="text-right hide-sm">{formatDuration(w.call_seconds)}</td>
                  <td className="text-right hide-sm">{w.quotations_accepted}/{w.quotations}</td>
                  <td className="text-right">{w.bookings}</td>
                  <td className="text-right hide-sm">{formatCurrency(w.booking_amount)}</td>
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(w.id);
                      }}
                    >
                      Drill down
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WorkerDetail({ id, period }: { id: number; period: string }) {
  const { data, loading, error, reload } = useQuery<any>(`/api/analytics/workers/${id}${qs({ period })}`);
  const d = data?.data;

  if (loading) return <TableSkeleton rows={8} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!d) return null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <strong>{d.worker.name}</strong>
        <Badge color={d.worker.status === 'ACTIVE' ? 'green' : 'gray'}>{d.worker.status}</Badge>
        <span className="small muted">{d.worker.email}</span>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {metricCards(d.metrics).map((m) => (
          <div key={m.label} className={`kpi${m.accent ? ` accent-${m.accent}` : ''}`}>
            <div className="label">{m.label}</div>
            <div className="value" style={{ fontSize: 17 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div className="divider" />
      <div className="small muted">Leads by status</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.by_lead_status.filter((s: any) => s.count > 0).map((s: any) => (
          <Badge key={s.code} color="outline">{s.name}: {s.count}</Badge>
        ))}
        {!d.by_lead_status.some((s: any) => s.count > 0) ? <span className="small muted">No leads.</span> : null}
      </div>

      <div className="divider" />
      <div className="small muted">Top destinations</div>
      {!d.by_destination.length ? (
        <span className="small muted">No destinations yet.</span>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {d.by_destination.map((r: any) => (
            <div key={r.destination} className="row small">
              <span>{r.destination}</span>
              <span className="right mono">{r.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />
      <div className="small muted">Upcoming follow-ups</div>
      {!d.upcoming_follow_ups.length ? (
        <span className="small muted">Nothing scheduled.</span>
      ) : (
        <div className="stack" style={{ gap: 7 }}>
          {d.upcoming_follow_ups.map((f: any) => (
            <div key={f.id} className="row small" style={{ gap: 8 }}>
              <span className="mono">{formatDate(f.scheduled_date)}{f.scheduled_time ? ` ${f.scheduled_time}` : ''}</span>
              <Badge color={f.status === 'OVERDUE' ? 'red' : 'blue'}>{f.status}</Badge>
              <span>{f.customer_name} · {f.destination ?? f.lead_number}</span>
            </div>
          ))}
        </div>
      )}

      <div className="divider" />
      <div className="small muted">Recent activity</div>
      {!d.recent_activity.length ? (
        <span className="small muted">No activity.</span>
      ) : (
        <div className="stack" style={{ gap: 7 }}>
          {d.recent_activity.map((t: any) => (
            <div key={t.id} className="row small" style={{ gap: 8 }}>
              <span className="mono muted">{formatDateTime(t.created_at)}</span>
              <span>{t.summary ?? t.type}</span>
              <span className="muted right">{t.lead_number}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
