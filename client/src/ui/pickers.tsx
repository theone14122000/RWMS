import { useState } from 'react';
import { qs, type ListResponse } from '../api/client';
import { useQuery } from '../lib/useQuery';
import { Badge, Field } from './atoms';

/** Type-ahead lead picker used by call / quotation / booking forms. */
export function LeadPicker({ value, onChange }: { value: any | null; onChange: (lead: any | null) => void }) {
  const [term, setTerm] = useState('');
  const { data, loading } = useQuery<ListResponse<any>>(
    term.trim().length >= 2 ? `/api/leads${qs({ search: term, limit: 8 })}` : null,
  );
  const options = data?.data ?? [];
  const selected = value;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="Lead" required hint="Search by lead number, customer or destination.">
        <input
          className="input"
          placeholder={selected ? 'Selected — type to change' : 'Type at least 2 characters…'}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </Field>
      {!selected && term.trim().length >= 2 ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 190, overflowY: 'auto' }}>
          {loading ? (
            <div className="small muted" style={{ padding: 10 }}>
              Searching…
            </div>
          ) : !options.length ? (
            <div className="small muted" style={{ padding: 10 }}>
              No leads match.
            </div>
          ) : (
            options.map((l: any) => (
              <button
                type="button"
                key={l.id}
                className="nav-item"
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => {
                  onChange(l);
                  setTerm('');
                }}
              >
                <span className="mono">{l.lead_number}</span> · {l.customer?.name ?? '—'} · {l.destination}
              </button>
            ))
          )}
        </div>
      ) : null}
      {selected ? (
        <div className="row small">
          <Badge color="green">Selected</Badge>
          <span className="mono">{selected.lead_number}</span>
          <span className="muted">
            {selected.customer?.name} · {selected.destination}
          </span>
          <button type="button" className="btn btn-ghost btn-sm right" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
      ) : null}
    </div>
  );
}
