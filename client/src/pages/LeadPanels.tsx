import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatCurrency, formatDate, formatDateTime, formatDuration } from '../lib/format';
import { Badge, EmptyState, Field } from '../ui/atoms';
import { Modal, useConfirm } from '../ui/overlays';
import { useToast } from '../ui/Toast';

const CALL_TONE: Record<string, 'green' | 'red' | 'amber' | 'gray' | 'cyan'> = {
  ANSWERED: 'green',
  COMPLETED: 'green',
  MISSED: 'red',
  NO_ANSWER: 'red',
  FAILED: 'red',
  BUSY: 'amber',
  RINGING: 'cyan',
};

const QUOTE_TONE: Record<string, 'gray' | 'blue' | 'cyan' | 'green' | 'red' | 'amber'> = {
  DRAFT: 'gray',
  SENT: 'blue',
  VIEWED: 'cyan',
  NEGOTIATION: 'amber',
  ACCEPTED: 'green',
  REJECTED: 'red',
  EXPIRED: 'amber',
  CANCELLED: 'gray',
};

const MSG_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  QUEUED: 'blue',
  SENT: 'green',
  DELIVERED: 'green',
  READ: 'green',
  FAILED: 'red',
  NOT_CONFIGURED: 'gray',
  IN_APP: 'blue',
};

/* --------------------------------- CALLS -------------------------------- */

export function LeadCallsTab({
  lead,
  calls,
  onChanged,
}: {
  lead: any;
  calls: any[];
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Calls</h3>
        <div className="right">
          <Link className="btn btn-sm" to={`/calls?lead_id=${lead.id}`}>
            Open call centre →
          </Link>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 8 }}
            disabled={!can('calls:create')}
            onClick={() => setOpen(true)}
          >
            + Log call
          </button>
        </div>
      </div>
      <div className="card-body tight">
        {!calls.length ? (
          <EmptyState
            title="No calls yet"
            description="Log outcomes as you go — the timeline and reports pick them up automatically."
            action={
              can('calls:create') ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
                  + Log call
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Phone</th>
                  <th>When</th>
                  <th className="text-right">Duration</th>
                  <th>Disposition</th>
                  <th>Worker</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Badge color={c.direction === 'INBOUND' ? 'cyan' : 'purple'}>{c.direction}</Badge>
                    </td>
                    <td>
                      <Badge color={CALL_TONE[c.status] ?? 'gray'}>{c.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="mono small">{c.phone_number ?? '—'}</td>
                    <td className="small muted nowrap">{formatDateTime(c.started_at ?? c.created_at)}</td>
                    <td className="text-right mono small">{formatDuration(c.duration_seconds)}</td>
                    <td className="small">{c.disposition ?? '—'}</td>
                    <td className="small">{c.worker_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open ? (
        <LogCallModal
          lead={lead}
          onClose={() => setOpen(false)}
          onLogged={() => {
            setOpen(false);
            onChanged();
            toast.push('success', 'Call logged');
          }}
        />
      ) : null}
    </div>
  );
}

function LogCallModal({ lead, onClose, onLogged }: { lead: any; onClose: () => void; onLogged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setError(null);
    try {
      await post('/api/calls', {
        lead_id: lead.id,
        direction: fd.get('direction'),
        status: fd.get('status'),
        phone_number: (fd.get('phone_number') as string) || lead.customer?.phone || null,
        duration_seconds: Number(fd.get('duration_seconds')) || 0,
        disposition: (fd.get('disposition') as string) || null,
        notes: (fd.get('notes') as string) || null,
      });
      onLogged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to log call');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log call"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="log-call-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Log call'}
          </button>
        </>
      }
    >
      <form id="log-call-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Direction">
            <select className="select" name="direction" defaultValue="OUTBOUND">
              <option value="OUTBOUND">Outbound</option>
              <option value="INBOUND">Inbound</option>
            </select>
          </Field>
          <Field label="Outcome">
            <select className="select" name="status" defaultValue="COMPLETED">
              <option value="COMPLETED">Completed</option>
              <option value="ANSWERED">Answered</option>
              <option value="NO_ANSWER">No answer</option>
              <option value="MISSED">Missed</option>
              <option value="BUSY">Busy</option>
              <option value="FAILED">Failed</option>
            </select>
          </Field>
          <Field label="Phone">
            <input className="input" name="phone_number" defaultValue={lead.customer?.phone ?? ''} />
          </Field>
          <Field label="Duration (seconds)">
            <input className="input" name="duration_seconds" type="number" min={0} defaultValue={0} />
          </Field>
          <Field label="Disposition">
            <input className="input" name="disposition" placeholder="Interested / Callback / Not reachable" maxLength={60} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="textarea" name="notes" rows={3} maxLength={4000} />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------ QUOTATIONS ------------------------------ */

export function LeadQuotationsTab({
  leadId,
  quotations,
  onChanged,
}: {
  leadId: number;
  quotations: any[];
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Quotations</h3>
        <div className="right">
          <Link className="btn btn-sm" to="/quotations">
            All quotations →
          </Link>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 8 }}
            disabled={!can('quotations:create')}
            onClick={() => setOpen(true)}
          >
            + New quotation
          </button>
        </div>
      </div>
      <div className="card-body tight">
        {!quotations.length ? (
          <EmptyState title="No quotations yet" description="Send a priced itinerary to move this lead forward." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Status</th>
                  <th>Destination</th>
                  <th className="text-right">Amount</th>
                  <th>Valid until</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => (
                  <tr key={q.id}>
                    <td className="mono">{q.quotation_number}</td>
                    <td><Badge color={QUOTE_TONE[q.status] ?? 'gray'}>{q.status}</Badge></td>
                    <td>{q.destination ?? '—'}</td>
                    <td className="text-right"><strong>{formatCurrency(q.total_amount, q.currency)}</strong></td>
                    <td className="small muted">{formatDate(q.valid_until)}</td>
                    <td className="small muted nowrap">{formatDate(q.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open ? (
        <CreateQuotationForLeadModal
          leadId={leadId}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            onChanged();
            toast.push('success', 'Quotation created');
          }}
        />
      ) : null}
    </div>
  );
}

function CreateQuotationForLeadModal({ leadId, onClose, onCreated }: { leadId: number; onClose: () => void; onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Array<{ description: string; quantity: string; unit_price: string }>>([
    { description: '', quantity: '1', unit_price: '' },
  ]);

  const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setError(null);
    try {
      await post('/api/quotations', {
        lead_id: leadId,
        destination: (fd.get('destination') as string) || null,
        travel_start_date: (fd.get('travel_start_date') as string) || null,
        travel_end_date: (fd.get('travel_end_date') as string) || null,
        travelers: Number(fd.get('travelers')) || null,
        currency: (fd.get('currency') as string) || 'INR',
        valid_until: (fd.get('valid_until') as string) || null,
        notes: (fd.get('notes') as string) || null,
        items: items
          .filter((it) => it.description.trim())
          .map((it) => ({
            description: it.description.trim(),
            quantity: Number(it.quantity) || 1,
            unit_price: Number(it.unit_price) || 0,
          })),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create quotation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New quotation"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="lead-quote-form" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create draft'}
          </button>
        </>
      }
    >
      <form id="lead-quote-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {error ? (
          <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: 9, borderRadius: 8, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="Destination">
            <input className="input" name="destination" />
          </Field>
          <Field label="Travel start">
            <input className="input" name="travel_start_date" type="date" />
          </Field>
          <Field label="Travel end">
            <input className="input" name="travel_end_date" type="date" />
          </Field>
          <Field label="Travelers">
            <input className="input" name="travelers" type="number" min={1} />
          </Field>
          <Field label="Currency">
            <input className="input" name="currency" defaultValue="INR" maxLength={8} />
          </Field>
          <Field label="Valid until">
            <input className="input" name="valid_until" type="date" />
          </Field>
        </div>

        <div className="small muted">Line items</div>
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
                min={1}
                value={it.quantity}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              />
              <input
                className="input"
                style={{ width: 130 }}
                type="number"
                min={0}
                placeholder="Unit price"
                value={it.unit_price}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={items.length === 1}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setItems([...items, { description: '', quantity: '1', unit_price: '' }])}
          >
            + Add item
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

/* ------------------------------- DOCUMENTS ------------------------------ */

function formatSize(bytes?: number | null): string {
  const n = Number(bytes ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function LeadDocumentsTab({
  leadId,
  documents,
  onChanged,
}: {
  leadId: number;
  documents: any[];
  onChanged: () => void;
}) {
  const { can, user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.push('error', 'File too large', 'Maximum upload size is 10 MB.');
      return;
    }
    setBusy(true);
    try {
      const text = await file.arrayBuffer();
      const bytes = new Uint8Array(text);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      await post('/api/documents', {
        entity: 'LEAD',
        entity_id: leadId,
        category: category || null,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64: btoa(bin),
      });
      toast.push('success', 'Document uploaded', file.name);
      onChanged();
    } catch (err) {
      toast.push('error', 'Upload failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc: any) => {
    const okConfirm = await confirm({
      title: 'Delete document?',
      message: `${doc.filename} will be removed permanently.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!okConfirm) return;
    try {
      await del(`/api/documents/${doc.id}`);
      toast.push('success', 'Document deleted');
      onChanged();
    } catch (err) {
      toast.push('error', 'Delete failed', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Documents</h3>
        <div className="right">
          <select className="select" style={{ width: 150, marginRight: 8 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">No category</option>
            <option value="Itinerary">Itinerary</option>
            <option value="Visa">Visa</option>
            <option value="Insurance">Insurance</option>
            <option value="Ticket">Ticket</option>
            <option value="Passport">Passport</option>
            <option value="Other">Other</option>
          </select>
          <label className={`btn btn-sm${can('documents:upload') ? ' btn-primary' : ''}`} style={{ position: 'relative' }}>
            {busy ? 'Uploading…' : '+ Upload'}
            <input
              type="file"
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: can('documents:upload') ? 'pointer' : 'not-allowed' }}
              disabled={!can('documents:upload') || busy}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>
      <div className="card-body tight">
        {!documents.length ? (
          <EmptyState title="No documents" description="Passports, visas, tickets and itineraries live here." />
        ) : (
          documents.map((d) => (
            <div key={d.id} className="row" style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="cell-main">{d.filename}</div>
                <div className="cell-sub">
                  {d.category ?? 'Uncategorised'} · {formatSize(d.size_bytes)} · uploaded by {d.uploaded_by_name ?? '—'} ·{' '}
                  {formatDateTime(d.created_at)}
                </div>
              </div>
              <a className="btn btn-sm" href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">
                Open
              </a>
              {d.uploaded_by === user?.id || can('documents:manage') ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void remove(d)}>
                  ✕
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* -------------------------------- MESSAGES ------------------------------ */

const CHANNELS = [
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'IN_APP', label: 'In-app' },
];

export function LeadMessagesTab({
  lead,
  messages,
  onChanged,
}: {
  lead: any;
  messages: any[];
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [channel, setChannel] = useState('WHATSAPP');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const res = await post<{ data: any }>('/api/communications', {
        channel,
        lead_id: lead.id,
        subject: channel === 'EMAIL' ? subject : null,
        body: body.trim(),
      });
      const d = res.data;
      if (d.status === 'NOT_CONFIGURED') {
        toast.push('error', 'Integration Not Configured', 'Set up the channel credentials before sending.');
      } else {
        toast.push('success', 'Message queued', `${channel.toLowerCase()} · status ${d.status}`);
        setBody('');
        setSubject('');
        onChanged();
      }
    } catch (err) {
      toast.push('error', 'Send failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const aiDraft = async () => {
    setAiBusy(true);
    try {
      const res = await post<{ data: any }>('/api/ai/message-draft', {
        lead_id: lead.id,
        channel,
        purpose: 'follow up on the travel enquiry',
      });
      const d = res.data;
      if (!d.configured) {
        toast.push('info', 'Integration Not Configured', d.reason ?? 'Add AI credentials to enable drafting.');
      } else {
        setBody(d.draft ?? '');
        toast.push('success', 'Draft inserted', `${d.provider} · ${d.model} — review before sending.`);
      }
    } catch (err) {
      toast.push('error', 'Draft failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <h3>Send message</h3>
          <span className="right small muted">Drafts never send themselves — you always hit send.</span>
        </div>
        <div className="card-body">
          <form onSubmit={send} className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <select className="select" style={{ width: 160 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <button type="button" className="btn" disabled={aiBusy || !can('ai:use')} onClick={aiDraft}>
                {aiBusy ? 'Drafting…' : '✦ AI draft'}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !body.trim() || !can('communications:send')}>
                {busy ? 'Queuing…' : 'Send'}
              </button>
            </div>
            {channel === 'EMAIL' ? (
              <Field label="Subject">
                <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
              </Field>
            ) : null}
            <Field label="Message" required>
              <textarea
                className="textarea"
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
                placeholder={`Message to ${lead.customer?.name ?? 'the customer'}…`}
              />
            </Field>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Message history</h3>
        </div>
        <div className="card-body tight">
          {!messages.length ? (
            <EmptyState title="No messages yet" description="Sent and received messages appear here with delivery status." />
          ) : (
            messages.map((m) => (
              <div key={m.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                <div className="row" style={{ gap: 8 }}>
                  <Badge color="outline">{m.channel}</Badge>
                  <Badge color={MSG_TONE[m.status] ?? 'gray'}>{(m.status ?? '').replace(/_/g, ' ')}</Badge>
                  <span className="small muted">{m.recipient ?? '—'}</span>
                  <span className="small muted right">{formatDateTime(m.created_at)}</span>
                </div>
                {m.subject ? <div style={{ fontWeight: 650, fontSize: 13, marginTop: 4 }}>{m.subject}</div> : null}
                <div style={{ fontSize: 13.5, marginTop: 3, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                <div className="small muted" style={{ marginTop: 3 }}>
                  {m.sender_name ? `by ${m.sender_name}` : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
