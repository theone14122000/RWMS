import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { patch, ApiError } from '../api/client';
import { useToast } from '../ui/Toast';
import { Badge } from '../ui/atoms';

export default function Profile() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await patch('/api/auth/password', { current_password: current, new_password: next });
      toast.push('success', 'Password updated');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update the password');
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My profile</h1>
          <div className="sub">Your account details and password.</div>
        </div>
      </div>

      <div className="grid-2" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Account</h3>
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">Name</span>
              <span style={{ fontWeight: 600 }}>{user.name}</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">Email</span>
              <span style={{ fontWeight: 600 }}>{user.email}</span>
            </div>
            {user.phone ? (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">Phone</span>
                <span style={{ fontWeight: 600 }}>{user.phone}</span>
              </div>
            ) : null}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">Role</span>
              <Badge color={user.role === 'ADMIN' ? 'blue' : 'purple'}>{user.role}</Badge>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">Status</span>
              <Badge color={user.status === 'ACTIVE' ? 'green' : 'gray'}>{user.status}</Badge>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Change password</h3>
          </div>
          <div className="card-body">
            <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
              <div className="field">
                <label>Current password</label>
                <input
                  className="input"
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="field">
                <label>New password</label>
                <input
                  className="input"
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
                <div className="small muted" style={{ marginTop: 4 }}>
                  At least 8 characters with a letter and a number.
                </div>
              </div>
              <div className="field">
                <label>Confirm new password</label>
                <input
                  className="input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              {error ? (
                <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: '9px 12px', borderRadius: 8, fontSize: 13 }}>
                  {error}
                </div>
              ) : null}
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
