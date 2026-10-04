import { useState } from 'react';
import { qs } from '../api/client';
import { useQuery } from '../lib/useQuery';
import { formatDateTime } from '../lib/format';
import { Badge, EmptyState, ErrorState, Pagination, TableSkeleton } from '../ui/atoms';

const ACTION_TONE: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'gray' | 'purple'> = {
  LOGIN_SUCCESS: 'green',
  LOGIN_FAILED: 'red',
  LOGIN_BLOCKED: 'red',
  LOGOUT: 'gray',
  LEAD_CREATED: 'blue',
  LEAD_UPDATED: 'blue',
  LEAD_ASSIGNED: 'purple',
  LEAD_REASSIGNED: 'purple',
  LEAD_UNASSIGNED: 'amber',
  LEAD_STATUS_CHANGED: 'blue',
  FOLLOW_UP_CREATED: 'amber',
  FOLLOW_UP_UPDATED: 'amber',
  FOLLOW_UP_COMPLETED: 'green',
  FOLLOW_UP_CANCELLED: 'gray',
  WORKER_CREATED: 'purple',
  WORKER_UPDATED: 'purple',
  WORKER_STATUS_CHANGED: 'amber',
  CUSTOMER_CREATED: 'blue',
  CUSTOMER_UPDATED: 'blue',
  CUSTOMER_ARCHIVED: 'gray',
  NOTE_ADDED: 'blue',
  SETTING_UPDATED: 'gray',
};

export default function AuditLogs() {
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);

  const url = `/api/audit-logs${qs({ search, action, entity, page, limit: 25 })}`;
  const { data, loading, error, reload } = useQuery<{ data: any[]; meta: any }>(url);
  const { data: actions } = useQuery<{ data: any[] }>('/api/audit-logs/actions');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit logs</h1>
          <div className="sub">Immutable record of important actions — who did what, and when.</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="grow input-search">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Search action, entity, id or user…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          className="select"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All actions</option>
          {(actions?.data ?? []).map((a) => (
            <option key={a.action} value={a.action}>
              {a.action} ({a.count})
            </option>
          ))}
        </select>
        <select
          className="select"
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All entities</option>
          <option value="lead">Lead</option>
          <option value="follow_up">Follow-up</option>
          <option value="user">Worker</option>
          <option value="customer">Customer</option>
          <option value="setting">Setting</option>
        </select>
        {(search || action || entity) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setSearch('');
              setAction('');
              setEntity('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={8} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data?.data?.length ? (
          <EmptyState title="No audit entries" description="Actions like lead creation and assignment will appear here." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th className="hide-sm">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((row) => (
                    <tr key={row.id}>
                      <td className="small muted nowrap">{formatDateTime(row.created_at)}</td>
                      <td>
                        <div className="cell-main">{row.user_name ?? 'System'}</div>
                      </td>
                      <td>
                        <Badge color={ACTION_TONE[row.action] ?? 'gray'}>{row.action.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="small">
                        {row.entity}
                        {row.entity_id ? <span className="muted"> #{row.entity_id}</span> : null}
                      </td>
                      <td className="hide-sm small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.metadata && Object.keys(row.metadata).length ? JSON.stringify(row.metadata) : '—'}
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
                onPage={setPage}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
