import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../lib/useQuery';
import { formatDate } from '../lib/format';
import { Avatar, EmptyState, ErrorState, TableSkeleton, WorkerStatusBadge } from '../ui/atoms';

const PERIODS = [
  { value: '', label: 'Current workload' },
  { value: 'today', label: 'Assigned today' },
  { value: '7d', label: 'Assigned last 7 days' },
  { value: '30d', label: 'Assigned last 30 days' },
  { value: 'month', label: 'Assigned this month' },
];

export default function Workload() {
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const { data: payload, loading, error, reload } = useQuery<any>(
    `/api/workload${period || status ? `?period=${period}&status=${status}` : ''}`,
  );
  const data = payload?.data;
  const { data: queue, loading: queueLoading } = useQuery<any>(
    selected ? `/api/workload/today?worker_id=${selected}` : null,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Daily workload</h1>
          <div className="sub">Assigned vs completed vs pending vs overdue — per worker.</div>
        </div>
        <div className="actions">
          <Link className="btn" to="/leads?assigned=unassigned">
            Unassigned leads
          </Link>
        </div>
      </div>

      <div className="toolbar">
        <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All workers</option>
          <option value="ACTIVE">Active only</option>
          <option value="INACTIVE">Inactive only</option>
          <option value="SUSPENDED">Suspended only</option>
        </select>
        <span className="small muted">Select a row to see today's queue.</span>
      </div>

      <div className="kpi-grid">
        <div className="kpi accent-cyan">
          <div className="label">Assigned</div>
          <div className="value">{data?.totals?.assigned ?? 0}</div>
        </div>
        <div className="kpi accent-green">
          <div className="label">Completed</div>
          <div className="value">{data?.totals?.completed ?? 0}</div>
        </div>
        <div className="kpi accent">
          <div className="label">Pending</div>
          <div className="value">{data?.totals?.pending ?? 0}</div>
        </div>
        <div className={`kpi${(data?.totals?.overdue ?? 0) > 0 ? ' accent-red' : ''}`}>
          <div className="label">Overdue</div>
          <div className="value">{data?.totals?.overdue ?? 0}</div>
        </div>
        <div className="kpi accent-amber">
          <div className="label">Follow-ups today</div>
          <div className="value">{data?.totals?.follow_ups_today ?? 0}</div>
        </div>
        <div className="kpi accent-red">
          <div className="label">Follow-ups overdue</div>
          <div className="value">{data?.totals?.follow_ups_overdue ?? 0}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        {loading ? (
          <TableSkeleton rows={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data?.rows?.length ? (
          <EmptyState title="No workers found" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th className="text-right">Assigned</th>
                  <th className="text-right">Completed</th>
                  <th className="text-right">Pending</th>
                  <th className="text-right">Overdue</th>
                  <th className="text-right hide-sm">Converted</th>
                  <th className="text-right">FU today</th>
                  <th className="text-right hide-sm">FU overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr
                    key={r.worker_id}
                    className="clickable"
                    style={selected === r.worker_id ? { background: 'var(--primary-50)' } : undefined}
                    onClick={() => setSelected(selected === r.worker_id ? null : r.worker_id)}
                  >
                    <td>
                      <div className="row" style={{ gap: 9 }}>
                        <Avatar name={r.name} />
                        <div>
                          <div className="cell-main">{r.name}</div>
                          <div className="cell-sub">{r.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <WorkerStatusBadge status={r.status} />
                    </td>
                    <td className="text-right">
                      <strong>{r.assigned}</strong>
                    </td>
                    <td className="text-right" style={{ color: 'var(--success)', fontWeight: 650 }}>
                      {r.completed}
                    </td>
                    <td className="text-right">{r.pending}</td>
                    <td className="text-right" style={r.overdue > 0 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                      {r.overdue}
                    </td>
                    <td className="text-right hide-sm">{r.converted}</td>
                    <td className="text-right">{r.follow_ups_today}</td>
                    <td className="text-right hide-sm" style={r.follow_ups_overdue > 0 ? { color: 'var(--danger)' } : undefined}>
                      {r.follow_ups_overdue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected ? (
        <div className="card">
          <div className="card-head">
            <h3>Today's queue · {data?.rows?.find((r: any) => r.worker_id === selected)?.name}</h3>
            <button type="button" className="right btn btn-sm" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <div className="card-body tight">
            {queueLoading ? (
              <TableSkeleton rows={4} />
            ) : !queue?.data?.length ? (
              <EmptyState title="No leads due today" description="Nothing is scheduled for this worker right now." />
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
                      <th>Next follow-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.data.map((l: any) => (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/leads/${l.id}`} className="mono">
                            {l.lead_number}
                          </Link>
                        </td>
                        <td>{l.customer_name}</td>
                        <td>{l.destination}</td>
                        <td>{l.priority}</td>
                        <td>
                          <span className="badge" style={{ background: `${l.status_color}1a`, color: l.status_color }}>
                            {l.status_name}
                          </span>
                        </td>
                        <td className="small muted">{l.next_fu_date ? formatDate(l.next_fu_date) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
