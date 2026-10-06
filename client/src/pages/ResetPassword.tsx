import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useToast } from '../ui/Toast';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await post('/api/auth/password/reset', { token, new_password: password });
      toast.push('success', 'Password updated — sign in with your new password');
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset the password');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-panel">
          <div className="login-card card">
            <div className="card-body" style={{ padding: 28 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Reset link missing</div>
              <p className="small muted">This page requires a valid reset link. Request a new one.</p>
              <Link to="/forgot-password" className="btn btn-primary btn-block">
                Request reset link
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-hero">
        <span className="logo" style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.14)', display: 'grid', placeItems: 'center', fontWeight: 800 }}>
          TA
        </span>
        <h1>Choose a new password</h1>
        <p>At least 8 characters with a letter and a number. All sessions will be signed out.</p>
      </div>
      <div className="login-panel">
        <div className="login-card card">
          <div className="card-body" style={{ padding: 28 }}>
            <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
              <div className="field">
                <label>New password</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  autoFocus
                  required
                  minLength={8}
                />
              </div>
              <div className="field">
                <label>Confirm password</label>
                <input
                  className="input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
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
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
