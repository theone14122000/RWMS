import { useEffect, useState } from 'react';
import { ApiError, patch, post } from '../api/client';
import { useMeta } from '../lib/meta';
import { useQuery } from '../lib/useQuery';
import { Badge, ErrorState, Field, TableSkeleton, Tabs } from '../ui/atoms';
import { Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

export default function Settings() {
  const [tab, setTab] = useState('sources');
  const { reload } = useMeta();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>CRM settings</h1>
          <div className="sub">Configure lead sources, statuses and dropdown options used across the CRM.</div>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'sources', label: 'Lead sources' },
          { key: 'statuses', label: 'Lead statuses' },
          { key: 'options', label: 'Options & lists' },
          { key: 'integrations', label: 'Integrations' },
          { key: 'assignment', label: 'Assignment' },
          { key: 'policy', label: 'Calls & retention' },
        ]}
      />

      {tab === 'sources' ? <SourcesTab onChange={reload} /> : null}
      {tab === 'statuses' ? <StatusesTab onChange={reload} /> : null}
      {tab === 'options' ? <OptionsTab onChange={reload} /> : null}
      {tab === 'integrations' ? <IntegrationsTab /> : null}
      {tab === 'assignment' ? <AssignmentTab onChange={reload} /> : null}
      {tab === 'policy' ? <PolicyTab onChange={reload} /> : null}
    </>
  );
}

function SourcesTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: payload, loading, error, reload } = useQuery<any>('/api/meta');
  const data = payload?.data;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const toggle = async (source: any) => {
    const next = !source.is_active;
    const okConfirm = await confirm({
      title: next ? `Enable ${source.name}?` : `Disable ${source.name}?`,
      message: next ? 'It will appear in new lead forms.' : 'It will be hidden from new leads. Existing leads keep it.',
      confirmLabel: next ? 'Enable' : 'Disable',
      danger: !next,
    });
    if (!okConfirm) return;
    try {
      await patch(`/api/meta/sources/${source.id}`, { is_active: next });
      toast.push('success', 'Source updated');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Lead sources</h3>
        <div className="right">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            + Add source
          </button>
        </div>
      </div>
      {loading ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th className="text-right">Order</th>
                <th className="actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sources ?? []).map((s: any) => (
                <tr key={s.id}>
                  <td className="cell-main">{s.name}</td>
                  <td>
                    <Badge color={s.is_active ? 'green' : 'gray'}>{s.is_active ? 'Active' : 'Disabled'}</Badge>
                  </td>
                  <td className="text-right">{s.sort_order}</td>
                  <td className="actions-cell">
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditing(s);
                          setOpen(true);
                        }}
                      >
                        Rename
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => toggle(s)}>
                        {s.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <SourceModal
          initial={editing}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            reload();
            onChange();
            toast.push('success', editing ? 'Source updated' : 'Source added');
          }}
        />
      ) : null}
    </div>
  );
}

function SourceModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={initial ? 'Edit lead source' : 'Add lead source'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="source-form"
            className="btn btn-primary"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              const form = document.getElementById('source-form') as HTMLFormElement;
              const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
              setBusy(true);
              setError(null);
              try {
                if (initial) await patch(`/api/meta/sources/${initial.id}`, { name });
                else await post('/api/meta/sources', { name });
                onSaved();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Failed to save');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="source-form" className="stack" style={{ gap: 12 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <Field label="Source name" required>
          <input className="input" name="name" defaultValue={initial?.name ?? ''} required minLength={2} />
        </Field>
      </form>
    </Modal>
  );
}

function StatusesTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: payload, loading, error, reload } = useQuery<any>('/api/meta');
  const data = payload?.data;
  const [open, setOpen] = useState(false);

  const toggle = async (status: any) => {
    const next = !status.is_active;
    const okConfirm = await confirm({
      title: next ? `Enable ${status.name}?` : `Disable ${status.name}?`,
      message: next ? 'Workers will be able to select it.' : 'It will be hidden from status pickers. Existing leads keep it.',
      confirmLabel: next ? 'Enable' : 'Disable',
      danger: !next,
    });
    if (!okConfirm) return;
    try {
      await patch(`/api/meta/statuses/${status.id}`, { is_active: next });
      toast.push('success', 'Status updated');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Update failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  const CATEGORY_TONE: Record<string, 'green' | 'red' | 'gray' | 'blue'> = {
    WON: 'green',
    LOST: 'red',
    OPEN: 'blue',
    NEUTRAL: 'gray',
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Lead statuses</h3>
        <div className="right">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
            + Add status
          </button>
        </div>
      </div>
      {loading ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Code</th>
                <th>Category</th>
                <th>Active</th>
                <th className="actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.statuses ?? []).map((s: any) => (
                <tr key={s.id}>
                  <td>
                    <span className="badge" style={{ background: `${s.color}1a`, color: s.color }}>
                      <span className="dot" style={{ background: s.color }} />
                      {s.name}
                    </span>
                  </td>
                  <td className="mono">{s.code}</td>
                  <td>
                    <Badge color={CATEGORY_TONE[s.category] ?? 'gray'}>{s.category}</Badge>
                  </td>
                  <td>
                    <Badge color={s.is_active ? 'green' : 'gray'}>{s.is_active ? 'Enabled' : 'Disabled'}</Badge>
                  </td>
                  <td className="actions-cell">
                    <button type="button" className="btn btn-sm" onClick={() => toggle(s)}>
                      {s.is_active ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? (
        <StatusModal
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            reload();
            onChange();
            toast.push('success', 'Status added');
          }}
        />
      ) : null}
    </div>
  );
}

function StatusModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="Add lead status"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              const form = document.getElementById('status-form') as HTMLFormElement;
              const fd = new FormData(form);
              setBusy(true);
              setError(null);
              try {
                await post('/api/meta/statuses', {
                  code: fd.get('code'),
                  name: fd.get('name'),
                  category: fd.get('category'),
                  color: fd.get('color'),
                });
                onSaved();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Failed to save');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Add status'}
          </button>
        </>
      }
    >
      <form id="status-form" className="stack" style={{ gap: 12 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Display name" required>
            <input className="input" name="name" required minLength={2} />
          </Field>
          <Field label="Code" required hint="Uppercase, e.g. WONT_BOOK">
            <input className="input" name="code" required pattern="[A-Z0-9_]+" />
          </Field>
          <Field label="Category" required>
            <select className="select" name="category" defaultValue="OPEN">
              <option value="OPEN">Open (in pipeline)</option>
              <option value="WON">Won (conversion)</option>
              <option value="LOST">Lost</option>
              <option value="NEUTRAL">Neutral</option>
            </select>
          </Field>
          <Field label="Color">
            <input className="input" type="color" name="color" defaultValue="#2563eb" style={{ padding: 4 }} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

const OPTION_KEYS = [
  { key: 'trip_types', label: 'Trip types', hint: 'Shown in the trip type dropdown' },
  { key: 'requirements_options', label: 'Requirements', hint: 'Checkbox options on the lead form' },
  { key: 'follow_up_types', label: 'Follow-up types', hint: 'Call, WhatsApp, Email…' },
  { key: 'currencies', label: 'Currencies', hint: 'ISO codes' },
];

function OptionsTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any>('/api/meta/settings');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.data) return;
    const next: Record<string, string> = {};
    for (const item of data.data) {
      if (OPTION_KEYS.some((k) => k.key === item.key)) {
        next[item.key] = Array.isArray(item.value) ? item.value.join('\n') : String(item.value ?? '');
      }
    }
    setDrafts(next);
  }, [data]);

  const save = async (key: string) => {
    setBusyKey(key);
    try {
      const value = (drafts[key] ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      await patch(`/api/meta/settings/${key}`, { value });
      toast.push('success', 'Settings saved');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Save failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="stack">
      {loading ? (
        <div className="card">
          <TableSkeleton rows={5} />
        </div>
      ) : error ? (
        <div className="card">
          <ErrorState message={error} onRetry={reload} />
        </div>
      ) : (
        OPTION_KEYS.map((opt) => (
          <div className="card" key={opt.key}>
            <div className="card-head">
              <h3>{opt.label}</h3>
              <span className="right small muted">{opt.hint}</span>
            </div>
            <div className="card-body">
              <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
                <textarea
                  className="textarea"
                  style={{ flex: 1, minHeight: 150 }}
                  value={drafts[opt.key] ?? ''}
                  onChange={(e) => setDrafts({ ...drafts, [opt.key]: e.target.value })}
                  placeholder={'One item per line'}
                />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="small muted">One item per line · changes apply to all new forms immediately</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm right"
                  disabled={busyKey === opt.key}
                  onClick={() => save(opt.key)}
                >
                  {busyKey === opt.key ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <Badge color={ok ? 'green' : 'gray'}>{ok ? 'Configured' : 'Not configured'}</Badge>
  );
}

function IntegrationsTab() {
  const { data, loading, error, reload } = useQuery<any>('/api/meta/integrations');
  const d = data?.data;

  if (loading) return <div className="card"><TableSkeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><ErrorState message={error ?? 'No data'} onRetry={reload} /></div>;

  const channels = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'email', label: 'Email' },
    { key: 'sms', label: 'SMS' },
    { key: 'in_app', label: 'In-app notifications' },
  ];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Telephony / calling</h3>
          <div className="right"><StatusDot ok={d.telephony?.configured} /></div>
        </div>
        <div className="card-body stack small" style={{ gap: 7 }}>
          {!d.telephony?.configured ? (
            <div className="small" style={{ color: 'var(--amber)' }}>
              Integration Not Configured — outbound calling is disabled until a provider is selected and its API base
              URL plus secret are set.
            </div>
          ) : null}
          <div className="row small"><span className="muted" style={{ width: 130 }}>Provider</span><span>{d.telephony.label} ({d.telephony.provider})</span></div>
          <div className="row small"><span className="muted" style={{ width: 130 }}>Base URL</span><span className="mono">{d.telephony.base_url || '—'}</span></div>
          <div className="row small">
            <span className="muted" style={{ width: 130 }}>Secret</span>
            <span className="mono">{d.telephony.auth_env}</span>
            <Badge color={d.telephony.secret_present ? 'green' : 'gray'}>{d.telephony.secret_present ? 'set in env' : 'missing in env'}</Badge>
          </div>
          <div className="small muted">Secrets live in environment variables — they are never stored in the database.</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Messaging channels</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Base URL</th>
                <th>Secret</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const ch = d.channels?.[c.key];
                return (
                  <tr key={c.key}>
                    <td className="cell-main">{c.label}</td>
                    <td><StatusDot ok={Boolean(ch?.configured)} /></td>
                    <td className="small">{ch?.provider ?? '—'}</td>
                    <td className="small mono">{ch?.base_url || '—'}</td>
                    <td>
                      {ch?.provider === 'internal' ? (
                        <span className="small muted">n/a</span>
                      ) : (
                        <Badge color={ch?.secret_present ? 'green' : 'gray'}>{ch?.secret_present ? 'set' : 'missing'}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <div className="small muted">
            Unconfigured channels stay visible but send nothing — messages are never faked as delivered.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>AI assistance</h3>
          <div className="right"><StatusDot ok={d.ai?.configured} /></div>
        </div>
        <div className="card-body stack small" style={{ gap: 7 }}>
          {!d.ai?.configured ? (
            <div className="small" style={{ color: 'var(--amber)' }}>
              Integration Not Configured — AI drafting is disabled ({d.ai?.reason ?? 'no credentials'}). Drafts stay
              suggestions until you send them yourself.
            </div>
          ) : null}
          <div className="row small"><span className="muted" style={{ width: 130 }}>Provider</span><span>{d.ai.provider}</span></div>
          <div className="row small"><span className="muted" style={{ width: 130 }}>Model</span><span className="mono">{d.ai.model}</span></div>
          <div className="row small"><span className="muted" style={{ width: 130 }}>Enabled</span><Badge color={d.ai.enabled ? 'green' : 'gray'}>{d.ai.enabled ? 'Yes' : 'No'}</Badge></div>
          <div className="row small">
            <span className="muted" style={{ width: 130 }}>Secret</span>
            <span className="mono">{d.ai.auth_env}</span>
            <Badge color={d.ai.secret_present ? 'green' : 'gray'}>{d.ai.secret_present ? 'set in env' : 'missing in env'}</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

const STRATEGIES = [
  { value: 'MANUAL', label: 'Manual — never auto-assign' },
  { value: 'ROUND_ROBIN', label: 'Round robin — cycle through workers' },
  { value: 'WORKLOAD', label: 'Workload — least open leads first' },
  { value: 'DESTINATION', label: 'Destination — follow rules below' },
  { value: 'SKILL', label: 'Skill — match worker skills to the lead' },
];

function AssignmentTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any>('/api/meta/integrations');
  const { data: usersPayload } = useQuery<{ data: any[] }>('/api/users?status=ACTIVE&limit=100');
  const workers = (usersPayload?.data ?? []).filter((u) => u.id !== 1);
  const assignment = data?.data?.assignment;
  const [busy, setBusy] = useState(false);

  const [strategy, setStrategy] = useState('');
  const [autoNew, setAutoNew] = useState(false);
  const [rules, setRules] = useState<Array<{ destination: string; worker_ids: number[] }>>([]);

  useEffect(() => {
    if (!assignment) return;
    setStrategy(assignment.strategy);
    setAutoNew(Boolean(assignment.auto_assign_new));
    setRules(Array.isArray(assignment.destination_rules) ? assignment.destination_rules : []);
  }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      await patch('/api/meta/settings/assignment', {
        value: { strategy, auto_assign_new: autoNew, destination_rules: rules.filter((r) => r.destination.trim()) },
      });
      toast.push('success', 'Assignment settings saved', autoNew && strategy !== 'MANUAL' ? 'New leads will auto-assign on creation.' : undefined);
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Save failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><TableSkeleton rows={6} /></div>;
  if (error || !assignment) return <div className="card"><ErrorState message={error ?? 'No data'} onRetry={reload} /></div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Assignment strategy</h3></div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <Field label="Strategy" hint="Used when auto-assigning new leads and by the assignment sweep in Automation.">
            <select className="select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>
          <label className="row small" style={{ gap: 9, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoNew}
              disabled={strategy === 'MANUAL'}
              onChange={(e) => setAutoNew(e.target.checked)}
            />
            <span>
              Auto-assign new leads on creation
              {strategy === 'MANUAL' ? ' (disabled while the strategy is Manual)' : ''}
            </span>
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Destination rules</h3>
          <div className="right">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRules([...rules, { destination: '', worker_ids: [] }])}
            >
              + Add rule
            </button>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 10 }}>
          <div className="small muted">
            When the strategy is Destination, a lead whose destination contains the rule text routes to the picked
            workers.
          </div>
          {!rules.length ? (
            <div className="small muted">No rules yet.</div>
          ) : (
            rules.map((rule, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  placeholder="Destination contains…"
                  value={rule.destination}
                  onChange={(e) => setRules(rules.map((r, j) => (j === i ? { ...r, destination: e.target.value } : r)))}
                />
                <select
                  className="select"
                  multiple
                  style={{ flex: 1, minHeight: 74 }}
                  value={rule.worker_ids.map(String)}
                  onChange={(e) =>
                    setRules(
                      rules.map((r, j) =>
                        j === i ? { ...r, worker_ids: Array.from(e.target.selectedOptions).map((o) => Number(o.value)) } : r,
                      ),
                    )
                  }
                >
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="row">
        <span className="small muted">Changes apply to the next assignment pass.</span>
        <button type="button" className="btn btn-primary right" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save assignment settings'}
        </button>
      </div>
    </div>
  );
}

function PolicyTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const { data, loading, error, reload } = useQuery<any>('/api/meta/integrations');
  const d = data?.data;
  const [busy, setBusy] = useState<string | null>(null);

  const [recordingMode, setRecordingMode] = useState('');
  const [consentNotice, setConsentNotice] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [remindersOn, setRemindersOn] = useState(true);
  const [overdueOn, setOverdueOn] = useState(true);
  const [retention, setRetention] = useState({ call_recordings_days: '', communications_days: '', documents_days: '', audit_logs_days: '' });

  useEffect(() => {
    if (!d) return;
    setRecordingMode(d.call_policy?.recording_mode ?? 'PROVIDER_DEFAULT');
    setConsentNotice(d.call_policy?.consent_notice ?? '');
    setRetentionDays(String(d.call_policy?.retention_days ?? 180));
    setRemindersOn(d.reminders?.enabled !== false);
    setOverdueOn(d.reminders?.overdue_enabled !== false);
    setRetention({
      call_recordings_days: String(d.retention?.call_recordings_days ?? 0),
      communications_days: String(d.retention?.communications_days ?? 0),
      documents_days: String(d.retention?.documents_days ?? 0),
      audit_logs_days: String(d.retention?.audit_logs_days ?? 0),
    });
  }, [data]);

  const savePolicy = async () => {
    setBusy('policy');
    try {
      await patch('/api/meta/settings/call_policy', {
        value: { recording_mode: recordingMode, consent_notice: consentNotice, retention_days: Number(retentionDays) || 0 },
      });
      toast.push('success', 'Call policy saved');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Save failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const saveReminders = async () => {
    setBusy('reminders');
    try {
      await patch('/api/meta/settings/reminders', { value: { enabled: remindersOn, overdue_enabled: overdueOn } });
      toast.push('success', 'Reminder settings saved');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Save failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const saveRetention = async () => {
    setBusy('retention');
    try {
      await patch('/api/meta/settings/retention', {
        value: {
          call_recordings_days: Number(retention.call_recordings_days) || 0,
          communications_days: Number(retention.communications_days) || 0,
          documents_days: Number(retention.documents_days) || 0,
          audit_logs_days: Number(retention.audit_logs_days) || 0,
        },
      });
      toast.push('success', 'Retention settings saved', 'Cleanup runs in the automation pass.');
      reload();
      onChange();
    } catch (err) {
      toast.push('error', 'Save failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="card"><TableSkeleton rows={6} /></div>;
  if (error || !d) return <div className="card"><ErrorState message={error ?? 'No data'} onRetry={reload} /></div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Call policy</h3></div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="Recording mode">
              <select className="select" value={recordingMode} onChange={(e) => setRecordingMode(e.target.value)}>
                <option value="PROVIDER_DEFAULT">Provider default</option>
                <option value="RECORD">Always record</option>
                <option value="DO_NOT_RECORD">Do not record</option>
              </select>
            </Field>
            <Field label="Default retention (days)" hint="Applied to new recordings. 0 = keep forever.">
              <input
                className="input"
                type="number"
                min={0}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Consent notice" hint="Shown to agents before placing a call.">
            <textarea
              className="textarea"
              rows={2}
              value={consentNotice}
              onChange={(e) => setConsentNotice(e.target.value)}
              maxLength={500}
            />
          </Field>
          <div className="row">
            <span className="small muted">Policy applies to manual calls and telephony webhooks alike.</span>
            <button type="button" className="btn btn-primary btn-sm right" disabled={busy === 'policy'} onClick={savePolicy}>
              {busy === 'policy' ? 'Saving…' : 'Save call policy'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Reminders</h3></div>
        <div className="card-body stack" style={{ gap: 10 }}>
          <label className="row small" style={{ gap: 9, cursor: 'pointer' }}>
            <input type="checkbox" checked={remindersOn} onChange={(e) => setRemindersOn(e.target.checked)} />
            <span>Due follow-up reminders (notifications on the scheduled day)</span>
          </label>
          <label className="row small" style={{ gap: 9, cursor: 'pointer' }}>
            <input type="checkbox" checked={overdueOn} onChange={(e) => setOverdueOn(e.target.checked)} />
            <span>Overdue follow-up reminders (daily nag while a follow-up is past due)</span>
          </label>
          <div className="row">
            <span className="small muted">Sent by the automation pass — see Automation to run it manually.</span>
            <button type="button" className="btn btn-primary btn-sm right" disabled={busy === 'reminders'} onClick={saveReminders}>
              {busy === 'reminders' ? 'Saving…' : 'Save reminders'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Data retention</h3>
          <span className="right small muted">0 = keep forever</span>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="Call recordings (days)">
              <input
                className="input"
                type="number"
                min={0}
                value={retention.call_recordings_days}
                onChange={(e) => setRetention({ ...retention, call_recordings_days: e.target.value })}
              />
            </Field>
            <Field label="Communications (days)">
              <input
                className="input"
                type="number"
                min={0}
                value={retention.communications_days}
                onChange={(e) => setRetention({ ...retention, communications_days: e.target.value })}
              />
            </Field>
            <Field label="Documents (days)">
              <input
                className="input"
                type="number"
                min={0}
                value={retention.documents_days}
                onChange={(e) => setRetention({ ...retention, documents_days: e.target.value })}
              />
            </Field>
            <Field label="Audit logs (days)">
              <input
                className="input"
                type="number"
                min={0}
                value={retention.audit_logs_days}
                onChange={(e) => setRetention({ ...retention, audit_logs_days: e.target.value })}
              />
            </Field>
          </div>
          <div className="row">
            <span className="small muted">Expired records are removed during the automation pass.</span>
            <button type="button" className="btn btn-primary btn-sm right" disabled={busy === 'retention'} onClick={saveRetention}>
              {busy === 'retention' ? 'Saving…' : 'Save retention'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
