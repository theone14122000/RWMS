import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime, formatDuration, timeAgo } from '../lib/format';
import { Badge, EmptyState, ErrorState, FollowUpStatusBadge, LoadingState, PriorityBadge, StatusBadge, TableSkeleton } from '../ui/atoms';
import { useMeta } from '../lib/meta';

/* ------------------------------- helpers ------------------------------- */

function Kpi({
  label,
  value,
  foot,
  accent,
}: {
  label: string;
  value: number | string;
  foot?: string;
  accent?: string;
}) {
  return (
    <div className={`kpi${accent ? ` accent-${accent}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );
}

function BarChart({ data, color }: { data: Array<{ label: string; value: number; color?: string }>; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <div className="muted small">No data yet</div>;
  return (
    <div className="bar-chart">
      {data.map((d, i) => (
        <div className="bar-row" key={`${d.label}-${i}`}>
          <span className="lbl" title={d.label}>
            {d.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: d.color || color }} />
          </div>
          <span className="val">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function ColumnChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <div className="muted small">No data yet</div>;
  return (
    <div className="column-chart">
      {data.map((d, i) => (
        <div className="col-item" key={`${d.label}-${i}`} title={`${d.label}: ${d.value}`}>
          <span className="col-val">{d.value}</span>
          <div className="col-bar" style={{ height: `${Math.max(4, (d.value / max) * 78)}%` }} />
          <span className="col-lbl">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function FollowUpMiniRow({ fu }: { fu: any }) {
  return (
    <div className="row" style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="cell-main">{fu.customer_name}</div>
        <div className="cell-sub">
          {fu.destination} · {fu.lead_number}
        </div>
      </div>
      <div className="hide-sm small muted nowrap">
        {formatDate(fu.scheduled_date)} {fu.scheduled_time ? `· ${fu.scheduled_time}` : ''}
      </div>
      <FollowUpStatusBadge status={fu.status === 'PENDING' ? undefined : fu.status} />
      <span className="small muted nowrap hide-sm">{fu.worker_name}</span>
    </div>
  );
}

/* ------------------------------ admin view ------------------------------ */

function AdminDashboard() {
  const { data: payload, loading, error, reload } = useQuery<any>('/api/dashboard/admin');

  if (loading) return <TableSkeleton rows={6} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const data = payload?.data;
  if (!data) return <EmptyState title="No data" />;

  const t = data.totals;
  const charts = data.charts;
  const lists = data.lists;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin dashboard</h1>
          <div className="sub">Team-wide pipeline health · {formatDate(data.filters.today)}</div>
        </div>
        <div className="actions">
          <Link className="btn" to="/leads?assigned=unassigned">
            Unassigned leads ({t.unassigned_leads})
          </Link>
          <Link className="btn btn-primary" to="/workload">
            Team workload
          </Link>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label="Total leads" value={t.total_leads} accent="cyan" />
        <Kpi label="New leads" value={t.new_leads} accent="blue" />
        <Kpi label="Unassigned" value={t.unassigned_leads} accent="amber" foot="Needs an owner" />
        <Kpi label="Assigned" value={t.assigned_leads} />
        <Kpi label="Today's follow-ups" value={t.todays_follow_ups} accent="blue" />
        <Kpi label="Overdue follow-ups" value={t.overdue_follow_ups} accent={t.overdue_follow_ups > 0 ? 'red' : undefined} />
        <Kpi label="Conversions" value={t.conversions} accent="green" />
        <Kpi label="Not interested" value={t.not_interested} accent="red" />
        <Kpi label="Active workers" value={t.active_workers} />
        <Kpi
          label="Calls today"
          value={t.calls_today ?? 0}
          accent="cyan"
          foot={`${t.calls_connected_today ?? 0} connected · ${t.calls_missed_today ?? 0} missed`}
        />
        <Kpi
          label="Open quotations"
          value={t.open_quotations ?? 0}
          foot={formatCurrency(t.open_quotation_amount ?? 0)}
        />
        <Kpi label="Active bookings" value={t.active_bookings ?? 0} accent="blue" />
        <Kpi label="Collected" value={formatCurrency(t.collected_amount ?? 0)} accent="green" />
        <Kpi
          label="Outstanding"
          value={formatCurrency(t.outstanding_amount ?? 0)}
          accent={(t.outstanding_amount ?? 0) > 0 ? 'red' : undefined}
        />
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Leads by status</h3>
          </div>
          <div className="card-body">
            <BarChart
              data={charts.leads_by_status.map((s: any) => ({ label: s.name, value: s.count, color: s.color }))}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Leads created (trend)</h3>
            <span className="right small muted">{charts.leads_trend.length} days</span>
          </div>
          <div className="card-body">
            <ColumnChart
              data={charts.leads_trend.map((d: any) => ({
                label: d.date.slice(5),
                value: d.count,
              }))}
            />
          </div>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Leads by source</h3>
          </div>
          <div className="card-body">
            <BarChart data={charts.leads_by_source.map((s: any) => ({ label: s.name, value: s.count }))} color="#0891b2" />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Follow-up outcomes</h3>
          </div>
          <div className="card-body">
            <BarChart
              data={charts.follow_up_outcomes.map((s: any) => ({
                label: s.status.replace(/_/g, ' '),
                value: s.count,
                color:
                  s.status === 'CONVERTED' || s.status === 'COMPLETED'
                    ? '#16a34a'
                    : s.status === 'OVERDUE' || s.status === 'NOT_INTERESTED'
                      ? '#dc2626'
                      : '#2563eb',
              }))}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Unassigned leads</h3>
            <Link className="right small" to="/leads?assigned=unassigned">
              View all →
            </Link>
          </div>
          <div className="card-body tight" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {lists.unassigned_leads.length === 0 ? (
              <EmptyState title="All leads assigned" description="Nice work — nothing is waiting for an owner." />
            ) : (
              lists.unassigned_leads.map((l: any) => (
                <div key={l.id} className="row" style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Link to={`/leads/${l.id}`} className="cell-main">
                      {l.lead_number}
                    </Link>
                    <div className="cell-sub">
                      {l.customer_name} → {l.destination}
                    </div>
                  </div>
                  <PriorityBadge priority={l.priority} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Today's follow-ups</h3>
            <Link className="right small" to="/follow-ups?status=TODAY">
              Open board →
            </Link>
          </div>
          <div className="card-body tight">
            {lists.todays_follow_ups.length === 0 ? (
              <EmptyState title="Nothing scheduled today" />
            ) : (
              lists.todays_follow_ups.map((fu: any) => <FollowUpMiniRow key={fu.id} fu={fu} />)
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Overdue follow-ups</h3>
            <Link className="right small" to="/follow-ups?status=OVERDUE">
              View all →
            </Link>
          </div>
          <div className="card-body tight">
            {lists.overdue_follow_ups.length === 0 ? (
              <EmptyState title="No overdue follow-ups" description="Everything is on schedule." />
            ) : (
              lists.overdue_follow_ups.map((fu: any) => <FollowUpMiniRow key={fu.id} fu={fu} />)
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Recent calls</h3>
          <Link className="right small" to="/calls">
            All calls →
          </Link>
        </div>
        <div className="card-body tight">
          {!lists.recent_calls?.length ? (
            <EmptyState title="No calls yet" description="Log a call from a lead or the Calls page." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Lead</th>
                    <th>Direction</th>
                    <th>Status</th>
                    <th className="text-right">Duration</th>
                    <th>When</th>
                    <th>Worker</th>
                  </tr>
                </thead>
                <tbody>
                  {lists.recent_calls.map((c: any) => (
                    <tr key={c.id}>
                      <td className="cell-main">
                        {c.customer_name ?? <span className="muted">{c.phone_number}</span>}
                      </td>
                      <td>
                        {c.lead_id ? (
                          <Link to={`/leads/${c.lead_id}`} className="mono small">{c.lead_number}</Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <Badge color={c.direction === 'INBOUND' ? 'cyan' : 'purple'}>{c.direction}</Badge>
                      </td>
                      <td><Badge color={c.status === 'MISSED' || c.status === 'NO_ANSWER' ? 'red' : 'green'}>{c.status}</Badge></td>
                      <td className="text-right mono small">{formatDuration(c.duration_seconds)}</td>
                      <td className="muted small nowrap">{formatDateTime(c.started_at)}</td>
                      <td className="small">{c.worker_name ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Recent leads</h3>
          <Link className="right small" to="/leads">
            All leads →
          </Link>
        </div>
        <div className="card-body tight">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Customer</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th className="text-right">Budget</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {lists.recent_leads.map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      <Link to={`/leads/${l.id}`} className="mono">
                        {l.lead_number}
                      </Link>
                    </td>
                    <td>{l.customer_name}</td>
                    <td>{l.destination}</td>
                    <td>
                      <StatusBadge code={l.status_code} name={l.status_name} color={l.status_color} />
                    </td>
                    <td>{l.assignee_name ?? <span className="muted">Unassigned</span>}</td>
                    <td className="text-right">{formatCurrency(l.budget, l.currency)}</td>
                    <td className="muted small nowrap">{timeAgo(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------ worker view ------------------------------ */

function WorkerDashboard({ workerId }: { workerId?: number }) {
  const qs = workerId ? `?worker_id=${workerId}` : '';
  const { data: payload, loading, error, reload } = useQuery<any>(`/api/dashboard/worker${qs}`);
  const { statuses } = useMeta();

  if (loading) return <TableSkeleton rows={6} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const data = payload?.data;
  if (!data) return <EmptyState title="No data" />;

  const s = data.stats;
  const lists = data.lists;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My dashboard</h1>
          <div className="sub">Everything you need to act on today · {formatDate(data.filters.today)}</div>
        </div>
        <div className="actions">
          <Link className="btn" to="/follow-ups?status=OVERDUE">
            Overdue ({s.overdue_follow_ups})
          </Link>
          <Link className="btn btn-primary" to="/leads">
            My leads
          </Link>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label="Today's leads" value={s.today_leads} accent="blue" foot="Need action today" />
        <Kpi label="Pending leads" value={s.pending_leads} />
        <Kpi label="Completed" value={s.completed} foot="Won + lost" />
        <Kpi label="Today's follow-ups" value={s.today_follow_ups} accent="cyan" />
        <Kpi
          label="Overdue follow-ups"
          value={s.overdue_follow_ups}
          accent={s.overdue_follow_ups > 0 ? 'red' : undefined}
        />
        <Kpi label="Converted" value={s.converted} accent="green" />
        <Kpi label="Not interested" value={s.not_interested} accent="red" />
        <Kpi
          label="Calls today"
          value={s.calls_today ?? 0}
          accent="cyan"
          foot={`${s.calls_connected_today ?? 0} connected · ${s.calls_missed_today ?? 0} missed`}
        />
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Today's lead queue</h3>
            <Link className="right small" to="/leads">
              All my leads →
            </Link>
          </div>
          <div className="card-body tight">
            {lists.today_leads.length === 0 ? (
              <EmptyState title="No leads due today" description="New assignments will show up here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>Customer</th>
                      <th>Destination</th>
                      <th>Priority</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lists.today_leads.map((l: any) => (
                      <tr key={l.id} className="clickable" onClick={() => (window.location.href = `/leads/${l.id}`)}>
                        <td>
                          <Link to={`/leads/${l.id}`} className="mono">
                            {l.lead_number}
                          </Link>
                        </td>
                        <td>
                          <div className="cell-main">{l.customer_name}</div>
                          <div className="cell-sub">{l.customer_phone}</div>
                        </td>
                        <td>{l.destination}</td>
                        <td>
                          <PriorityBadge priority={l.priority} />
                        </td>
                        <td>
                          <StatusBadge code={l.status_code} name={l.status_name} color={l.status_color} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>Today's follow-ups</h3>
              <Link className="right small" to="/follow-ups">
                Board →
              </Link>
            </div>
            <div className="card-body tight">
              {lists.today_follow_ups.length === 0 ? (
                <EmptyState title="Nothing scheduled today" />
              ) : (
                lists.today_follow_ups.map((fu: any) => <FollowUpMiniRow key={fu.id} fu={fu} />)
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Overdue follow-ups</h3>
            </div>
            <div className="card-body tight">
              {lists.overdue_follow_ups.length === 0 ? (
                <EmptyState title="No overdue follow-ups" description="You are all caught up." />
              ) : (
                lists.overdue_follow_ups.map((fu: any) => <FollowUpMiniRow key={fu.id} fu={fu} />)
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Today's calls</h3>
              <Link className="right small" to="/calls">
                All calls →
              </Link>
            </div>
            <div className="card-body tight">
              {!lists.today_calls?.length ? (
                <EmptyState title="No calls today" description="Log a call from any lead." />
              ) : (
                lists.today_calls.map((c: any) => (
                  <div key={c.id} className="row" style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="cell-main">{c.customer_name ?? c.phone_number}</div>
                      <div className="cell-sub">
                        {c.lead_number ? `${c.lead_number} · ` : ''}
                        {c.direction}
                      </div>
                    </div>
                    <Badge color={c.status === 'MISSED' || c.status === 'NO_ANSWER' ? 'red' : 'green'}>{c.status}</Badge>
                    <span className="small muted nowrap">{formatDuration(c.duration_seconds)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Recent activity</h3>
          </div>
          <div className="card-body tight">
            {lists.recent_activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              lists.recent_activity.map((a: any) => (
                <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge color="blue">{a.type.replace(/_/g, ' ')}</Badge>
                    <span className="small muted">{formatDateTime(a.created_at)}</span>
                  </div>
                  <div style={{ marginTop: 3, fontSize: 13.5 }}>{a.summary}</div>
                  <div className="cell-sub">
                    <Link to={`/leads/${a.lead_id}`}>
                      {a.lead_number} · {a.customer_name}
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Pipeline statuses</h3>
            <span className="right small muted">Use these on lead details</span>
          </div>
          <div className="card-body">
            <div className="row" style={{ gap: 8 }}>
              {statuses.map((s2) => (
                <StatusBadge key={s2.code} code={s2.code} name={s2.name} color={s2.color} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* --------------------------------- page --------------------------------- */

export default function Dashboard() {
  const { user, can } = useAuth();
  if (!user) return <LoadingState />;
  if (user.role === 'ADMIN' || can('dashboard:admin')) return <AdminDashboard />;
  return <WorkerDashboard />;
}
