import type { ReactNode } from 'react';

export function Spinner({ large }: { large?: boolean }) {
  return <div className={`spinner${large ? ' lg' : ''}`} aria-label="Loading" />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-state">
      <Spinner large />
      <div className="small muted">{label}</div>
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${94 - i * 6}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon = '◎',
  action,
}: {
  title: string;
  description?: string;
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="ico">{icon}</div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state">
      <div className="ico">⚠</div>
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  color = 'gray',
  dot,
}: {
  children: ReactNode;
  color?: 'gray' | 'blue' | 'green' | 'red' | 'amber' | 'cyan' | 'purple' | 'outline';
  dot?: boolean;
}) {
  const cls = color === 'outline' ? 'badge badge-outline' : `badge badge-${color}`;
  return (
    <span className={cls}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  NEW: 'blue',
  ASSIGNED: 'cyan',
  CONTACTED: 'purple',
  INTERESTED: 'cyan',
  FOLLOW_UP: 'amber',
  QUOTATION_SENT: 'amber',
  NEGOTIATION: 'purple',
  CONVERTED: 'green',
  NOT_INTERESTED: 'red',
  NO_RESPONSE: 'red',
  INVALID: 'gray',
  CLOSED: 'gray',
};

export function StatusBadge({ code, name, color }: { code?: string; name?: string; color?: string }) {
  const label = name || (code ? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : 'Unknown');
  if (color) {
    return (
      <span className="badge" style={{ background: `${color}1a`, color, borderColor: `${color}33` }}>
        <span className="dot" style={{ background: color }} />
        {label}
      </span>
    );
  }
  const tone = STATUS_COLORS[code ?? ''] ?? 'gray';
  return <Badge color={tone as 'gray'}>{label}</Badge>;
}

const PRIORITY_TONE: Record<string, 'red' | 'amber' | 'blue' | 'gray'> = {
  URGENT: 'red',
  HIGH: 'amber',
  MEDIUM: 'blue',
  LOW: 'gray',
};

export function PriorityBadge({ priority }: { priority?: string }) {
  if (!priority) return <span className="muted">—</span>;
  return <Badge color={PRIORITY_TONE[priority] ?? 'gray'}>{priority}</Badge>;
}

const FOLLOW_UP_TONE: Record<string, 'red' | 'amber' | 'blue' | 'green' | 'gray' | 'purple' | 'cyan'> = {
  PENDING: 'blue',
  TODAY: 'amber',
  OVERDUE: 'red',
  COMPLETED: 'green',
  CONVERTED: 'green',
  NOT_INTERESTED: 'red',
  RESCHEDULED: 'purple',
  NO_RESPONSE: 'gray',
  CALLBACK_REQUESTED: 'cyan',
  CANCELLED: 'gray',
};

export function FollowUpStatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="muted">—</span>;
  return <Badge color={FOLLOW_UP_TONE[status] ?? 'gray'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function WorkerStatusBadge({ status }: { status?: string }) {
  const tone = status === 'ACTIVE' ? 'green' : status === 'SUSPENDED' ? 'red' : 'gray';
  return <Badge color={tone as 'gray'}>{status ?? '—'}</Badge>;
}

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
  limit,
  onLimit,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
  limit?: number;
  onLimit?: (n: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total} record{total === 1 ? '' : 's'} · page {page} of {totalPages}
      </span>
      <span className="spacer" />
      {onLimit ? (
        <select
          className="select"
          style={{ width: 110, height: 30 }}
          value={limit}
          onChange={(e) => onLimit(Number(e.target.value))}
        >
          {[10, 20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
}

export function Field({
  label,
  required,
  error,
  hint,
  children,
  className = '',
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      <label>
        {label} {required ? <span className="req">*</span> : null}
      </label>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? <span className="err">{error}</span> : null}
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: string; label: string; count?: number }>;
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`tab${active === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, dark, lg }: { name?: string; dark?: boolean; lg?: boolean }) {
  const text = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  return <span className={`avatar${dark ? ' dark' : ''}${lg ? ' lg' : ''}`}>{text}</span>;
}
