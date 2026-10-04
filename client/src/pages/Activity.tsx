import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatDateTime } from '../lib/format';
import { Badge, EmptyState, ErrorState, TableSkeleton } from '../ui/atoms';

const TONE: Record<string, 'blue' | 'green' | 'amber' | 'purple' | 'gray' | 'red' | 'cyan'> = {
  LEAD_CREATED: 'blue',
  ASSIGNED: 'purple',
  REASSIGNED: 'purple',
  UNASSIGNED: 'amber',
  STATUS_CHANGED: 'blue',
  NOTE_ADDED: 'cyan',
  FOLLOW_UP_CREATED: 'amber',
  FOLLOW_UP_UPDATED: 'amber',
  FOLLOW_UP_COMPLETED: 'green',
  LEAD_UPDATED: 'gray',
};

export default function Activity() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useQuery<{ data: any[] }>(
    user ? `/api/users/${user.id}/activity?limit=50` : null,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My activity</h1>
          <div className="sub">Everything you have done on leads — your personal audit trail.</div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={6} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data?.data?.length ? (
          <EmptyState title="No activity yet" description="Actions you take on leads will show up here." />
        ) : (
          <div className="card-body">
            <div className="timeline">
              {data.data.map((ev: any) => (
                <div className="tl-item" key={ev.id}>
                  <div className="tl-dot">•</div>
                  <div className="tl-body">
                    <div className="tl-summary">{ev.summary}</div>
                    <div className="tl-time">
                      <Badge color={TONE[ev.type] ?? 'gray'}>{ev.type.replace(/_/g, ' ')}</Badge>{' '}
                      {formatDateTime(ev.created_at)}
                    </div>
                    <div className="tl-meta">
                      <Link to={`/leads/${ev.lead_id}`}>
                        {ev.lead_number} · {ev.customer_name} → {ev.destination}
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
