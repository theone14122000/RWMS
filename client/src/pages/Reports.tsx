import { useState } from 'react';
import { ApiError, get, post, qs, type ListResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format';
import { Badge, EmptyState, ErrorState, Field, Tabs, TableSkeleton } from '../ui/atoms';
import { Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

const EXPORTS = [
  { key: 'leads', label: 'Leads' },
  { key: 'customers', label: 'Customers' },
  { key: 'follow-ups', label: 'Follow-ups' },
  { key: 'calls', label: 'Calls' },
  { key: 'quotations', label: 'Quotations' },
  { key: 'bookings', label: 'Bookings' },
];

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
];

export default function Reports() {
  const { can } = useAuth();
  const [tab, setTab] = useState('summary');
  const isAdmin = can('reports:read');

  const tabs = [
    { key: 'summary', label: 'Summary' },
    { key: 'exports', label: 'Exports' },
    ...(can('imports:manage') ? [{ key: 'imports', label: 'Imports' }] : []),
    ...(can('leads:read_all') ? [{ key: 'duplicates', label: 'Duplicates' }] : []),
  ];

  if (!isAdmin && !can('imports:manage') && !can('leads:read_all')) {
    return <EmptyState title="No access" description="Ask your admin for reports or exports permission." />;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports &amp; data</h1>
          <div className="sub">Period reports, CSV exports, CSV imports and duplicate management.</div>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} tabs={tabs} />

      {tab === 'summary' && isAdmin ? <SummaryTab /> : null}
      {tab === 'exports' ? <ExportsTab /> : null}
      {tab === 'imports' ? <ImportsTab /> : null}
      {tab === 'duplicates' ? <DuplicatesTab /> : null}
    </>
  );
}

function SummaryTab() {
  const [period, setPeriod] = useState('month');
  const { data, loading, error, reload } = useQuery<any>(`/api/reports/summary?period=${period}`);
  const d = data?.data;

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        {d?.period ? (
          <span className="small muted">
            Window: {formatDate(d.period.from)} → {formatDate(d.period.to)}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="card"><TableSkeleton rows={6} /></div>
      ) : error ? (
        <div className="card"><ErrorState message={error} onRetry={reload} /></div>
      ) : !d ? null : (
        <>
          <div className="kpi-grid">
            <div className="kpi accent-cyan">
              <div className="label">Leads created</div>
              <div className="value">{d.leads.created_in_period}</div>
            </div>
            <div className="kpi accent-green">
              <div className="label">Conversions</div>
              <div className="value">{d.leads.converted}</div>
            </div>
            <div className="kpi">
              <div className="label">Conversion rate</div>
              <div className="value">{d.leads.conversion_rate}%</div>
            </div>
            <div className="kpi accent-amber">
              <div className="label">Follow-ups due</div>
              <div className="value">{d.follow_ups.due}</div>
            </div>
            <div className={`kpi${d.follow_ups.overdue > 0 ? ' accent-red' : ''}`}>
              <div className="label">Overdue follow-ups</div>
              <div className="value">{d.follow_ups.overdue}</div>
            </div>
            <div className="kpi accent-cyan">
              <div className="label">Calls</div>
              <div className="value">{d.calls.total}</div>
            </div>
            <div className="kpi accent-green">
              <div className="label">Quotations accepted</div>
              <div className="value">{d.quotations.accepted} / {d.quotations.total}</div>
            </div>
            <div className="kpi">
              <div className="label">Booking value</div>
              <div className="value" style={{ fontSize: 19 }}>{formatCurrency(d.bookings.amount)}</div>
            </div>
            <div className="kpi accent-green">
              <div className="label">Collected</div>
              <div className="value" style={{ fontSize: 19 }}>{formatCurrency(d.bookings.paid)}</div>
            </div>
            <div className={`kpi${d.bookings.outstanding > 0 ? ' accent-red' : ''}`}>
              <div className="label">Outstanding</div>
              <div className="value" style={{ fontSize: 19 }}>{formatCurrency(d.bookings.outstanding)}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Leads by status</h3>
            </div>
            <div className="card-body">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {d.leads.by_status.filter((s: any) => s.count > 0).map((s: any) => (
                  <span key={s.code} className="badge" style={{ background: `${s.color}1a`, color: s.color }}>
                    <span className="dot" style={{ background: s.color }} />
                    {s.name}: {s.count}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ExportsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [entity, setEntity] = useState('leads');
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const canExport = can('exports:run');
  const canPreview = can('reports:read');

  const loadPreview = async () => {
    setBusy(true);
    try {
      const res = await get<{ data: any }>(`/api/reports/exports/${entity}/preview?limit=50`);
      setPreview(res.data);
    } catch (err) {
      toast.push('error', 'Preview failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!canExport) return;
    try {
      const res = await fetch(`/api/reports/exports/${entity}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entity}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.push('success', 'Export downloaded', `${entity}.csv`);
    } catch (err) {
      toast.push('error', 'Export failed', err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>CSV export</h3>
          <span className="right small muted">Every export is recorded in the audit log.</span>
        </div>
        <div className="card-body">
          <div className="toolbar" style={{ padding: 0 }}>
            <select className="select" value={entity} onChange={(e) => { setEntity(e.target.value); setPreview(null); }}>
              {EXPORTS.map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </select>
            <button type="button" className="btn" disabled={busy || !canPreview} onClick={loadPreview}>
              {busy ? 'Loading…' : 'Preview (50 rows)'}
            </button>
            <button type="button" className="btn btn-primary" disabled={!canExport} onClick={download}>
              Download CSV
            </button>
            {!canExport ? <span className="small muted">You need the exports permission to download.</span> : null}
          </div>
        </div>
      </div>

      {preview ? (
        <div className="card">
          <div className="card-head">
            <h3>Preview · {preview.entity}</h3>
            <span className="right small muted">{preview.total} row(s) total</span>
          </div>
          {!preview.rows?.length ? (
            <EmptyState title="Nothing to export yet" />
          ) : (
            <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    {preview.header.map((h: string) => (
                      <th key={h}>{h.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row: any, i: number) => (
                    <tr key={i}>
                      {preview.header.map((h: string) => (
                        <td key={h} className="small">{row[h] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ImportsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const [reloadKey, setReloadKey] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const { data, loading, error, reload } = useQuery<ListResponse<any>>('/api/imports', [reloadKey]);
  const { data: detail, reload: reloadDetail } = useQuery<any>(detailId ? `/api/imports/${detailId}` : null, [reloadKey, uploadOpen ? 1 : 0]);

  const jobs = data?.data ?? [];

  const run = async (id: number) => {
    const okConfirm = await confirm({
      title: 'Run import?',
      message: 'Valid rows will create or link customers and leads. Invalid rows are skipped.',
      confirmLabel: 'Run import',
    });
    if (!okConfirm) return;
    try {
      const res = await post<{ data: any }>(`/api/imports/${id}/run`, { assign: 'AUTO', import_duplicates: false });
      toast.push('success', 'Import finished', `${res.data.imported_rows} imported · ${res.data.failed_rows} failed`);
      setReloadKey((k) => k + 1);
      setDetailId(id);
      reloadDetail();
      reload();
    } catch (err) {
      toast.push('error', 'Import failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  const remove = async (id: number) => {
    const okConfirm = await confirm({
      title: 'Delete import job?',
      message: 'Rows that were already imported are not removed.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!okConfirm) return;
    try {
      await post(`/api/imports/${id}/delete`, {});
      toast.push('success', 'Import deleted');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.push('error', 'Delete failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>CSV imports</h3>
          <div className="right">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploadOpen(true)}>
              + Upload CSV
            </button>
          </div>
        </div>
        {loading ? (
          <TableSkeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !jobs.length ? (
          <EmptyState
            title="No imports yet"
            description="Upload a CSV with name and phone columns to bulk-create leads."
            action={
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploadOpen(true)}>
                + Upload CSV
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Status</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Valid</th>
                  <th className="text-right">Invalid</th>
                  <th className="text-right">Duplicates</th>
                  <th className="text-right">Imported</th>
                  <th className="hide-sm">Created</th>
                  <th className="actions-cell">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="cell-main">{j.filename}</td>
                    <td>
                      <Badge color={j.status === 'COMPLETED' ? 'green' : j.status === 'PARSED' ? 'blue' : 'amber'}>{j.status}</Badge>
                    </td>
                    <td className="text-right">{j.total_rows}</td>
                    <td className="text-right" style={{ color: 'var(--success)' }}>{j.valid_rows}</td>
                    <td className="text-right" style={j.invalid_rows ? { color: 'var(--danger)' } : undefined}>{j.invalid_rows}</td>
                    <td className="text-right">{j.duplicate_rows}</td>
                    <td className="text-right"><strong>{j.imported_rows}</strong></td>
                    <td className="small muted hide-sm">{formatDateTime(j.created_at)}</td>
                    <td className="actions-cell">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn btn-sm" onClick={() => setDetailId(j.id)}>Preview</button>
                        {j.status === 'PARSED' ? (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => run(j.id)}>Run</button>
                        ) : null}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(j.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailId && detail?.data ? (
        <Modal
          title={`Import · ${detail.data.filename}`}
          onClose={() => setDetailId(null)}
          size="lg"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDetailId(null)}>Close</button>
              {detail.data.status === 'PARSED' ? (
                <button type="button" className="btn btn-primary" onClick={() => run(detail.data.id)}>Run import</button>
              ) : null}
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <Badge color={detail.data.status === 'COMPLETED' ? 'green' : 'blue'}>{detail.data.status}</Badge>
              <span className="small muted">
                {detail.data.valid_rows} valid · {detail.data.invalid_rows} invalid · {detail.data.duplicate_rows} duplicate ·{' '}
                {detail.data.imported_rows} imported
              </span>
            </div>
            {!detail.data.preview?.length ? (
              <EmptyState title="No preview rows" />
            ) : (
              <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Status</th>
                      <th>Name</th>
                      <th>Phone</th>
                      <th>Destination</th>
                      <th>Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.preview.map((r: any) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>
                          <Badge color={r.status === 'VALID' ? 'green' : r.status === 'DUPLICATE' ? 'amber' : 'red'}>{r.status}</Badge>
                        </td>
                        <td>{r.values?.name ?? ''}</td>
                        <td className="mono small">{r.values?.phone ?? ''}</td>
                        <td>{r.values?.destination ?? ''}</td>
                        <td className="small muted">{r.error ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detail.data.errors?.length ? (
              <div className="small" style={{ color: 'var(--danger)' }}>
                {detail.data.errors.slice(0, 5).map((e: any) => `Row ${e.row}: ${e.message}`).join(' · ')}
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {uploadOpen ? (
        <UploadCsvModal
          onClose={() => setUploadOpen(false)}
          onUploaded={(id) => {
            setUploadOpen(false);
            setReloadKey((k) => k + 1);
            reload();
            setDetailId(id);
          }}
        />
      ) : null}
    </div>
  );
}

function UploadCsvModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: (id: number) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    const text = await file.text();
    setContent(btoa(unescape(encodeURIComponent(text))));
  };

  const submit = async () => {
    if (!content) {
      setError('Choose a CSV file first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ data: any }>('/api/imports', { filename: fileName, content_base64: content });
      toast.push('success', 'CSV parsed', `${res.data.valid_rows} valid · ${res.data.invalid_rows} invalid · ${res.data.duplicate_rows} duplicate`);
      onUploaded(res.data.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Upload CSV"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !content} onClick={submit}>
            {busy ? 'Parsing…' : 'Parse CSV'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>{error}</div>
        ) : null}
        <Field label="CSV file" required hint="Must contain name and phone columns. Extra columns (destination, budget, source…) map automatically.">
          <input
            className="input"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </Field>
        {fileName ? (
          <div className="small muted">
            Selected: {fileName} — nothing is imported until you run the job.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

const DECISION_TONES: Record<string, 'green' | 'red' | 'gray' | 'blue'> = {
  OPEN: 'blue',
  MERGED: 'green',
  KEPT_SEPARATE: 'gray',
  LINKED: 'gray',
  IGNORED: 'gray',
};

function DuplicatesTab() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState('OPEN');
  const [scanning, setScanning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error, reload } = useQuery<ListResponse<any>>(`/api/duplicates${qs({ status, limit: 50 })}`, [reloadKey]);

  const reviews = data?.data ?? [];
  const canMerge = can('customers:merge');

  const scan = async () => {
    setScanning(true);
    try {
      const res = await post<{ data: any }>('/api/duplicates/scan');
      toast.push('success', 'Scan complete', `${res.data.customers_found} customer · ${res.data.leads_found} lead duplicate(s) found`);
      setReloadKey((k) => k + 1);
      reload();
    } catch (err) {
      toast.push('error', 'Scan failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setScanning(false);
    }
  };

  const decide = async (review: any, action: string) => {
    if (action === 'MERGED' && !canMerge) {
      toast.push('error', 'Missing permission', 'Merging requires customers:merge.');
      return;
    }
    if (action !== 'KEPT_SEPARATE') {
      const okConfirm = await confirm({
        title: action === 'MERGED' ? 'Merge duplicates?' : `Mark as ${action.toLowerCase()}?`,
        message:
          action === 'MERGED'
            ? 'All leads, calls, quotations and bookings move to the kept record. This cannot be undone.'
            : 'The review will be closed.',
        confirmLabel: action === 'MERGED' ? 'Merge' : 'Confirm',
        danger: action === 'MERGED',
      });
      if (!okConfirm) return;
    }
    try {
      await post(`/api/duplicates/${review.id}/decide`, { action });
      toast.push('success', 'Review resolved', action);
      setReloadKey((k) => k + 1);
      reload();
    } catch (err) {
      toast.push('error', 'Decision failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Duplicate detection</h3>
          <div className="right">
            <button type="button" className="btn btn-primary btn-sm" disabled={scanning} onClick={scan}>
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="small muted">
            Matches customers by phone and open leads by customer + destination. Nothing is merged automatically — every
            merge is an explicit, audited decision.
          </div>
        </div>
      </div>

      <div className="toolbar">
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="OPEN">Open reviews</option>
          <option value="MERGED">Merged</option>
          <option value="KEPT_SEPARATE">Kept separate</option>
          <option value="">All</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <TableSkeleton rows={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !reviews.length ? (
          <EmptyState title="No duplicate reviews" description="Run a scan to look for matching customers and leads." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Record</th>
                  <th>Candidate</th>
                  <th>Reason</th>
                  <th>Score</th>
                  <th>Status</th>
                  <th className="actions-cell">Decision</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td><Badge color="outline">{r.entity}</Badge></td>
                    <td className="small">{sideLabel(r.entity_data)}</td>
                    <td className="small">{sideLabel(r.candidate_data)}</td>
                    <td className="small muted">{r.reason ?? '—'}</td>
                    <td>
                      <Badge color={r.score === 'HIGH' ? 'red' : 'amber'}>{r.score ?? '—'}</Badge>
                    </td>
                    <td><Badge color={DECISION_TONES[r.status] ?? 'gray'}>{r.status}</Badge></td>
                    <td className="actions-cell">
                      {r.status === 'OPEN' ? (
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-sm btn-primary" disabled={!canMerge} onClick={() => decide(r, 'MERGED')}>
                            Merge
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => decide(r, 'KEPT_SEPARATE')}>
                            Keep both
                          </button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(r, 'IGNORED')}>
                            Ignore
                          </button>
                        </div>
                      ) : (
                        <span className="small muted">Decided {formatDate(r.decided_at)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function sideLabel(data: any): string {
  if (!data) return '—';
  if (typeof data === 'string') return data;
  if (data.name) return `${data.name}${data.phone ? ` · ${data.phone}` : ''}`;
  if (data.lead_number) return `${data.lead_number} · ${data.destination ?? ''}`;
  return JSON.stringify(data).slice(0, 60);
}
