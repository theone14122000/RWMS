import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { post, ApiError } from '../api/client';

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/api/auth/password/forgot', { identifier: identifier.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to start the reset');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <span className="logo" style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.14)', display: 'grid', placeItems: 'center', fontWeight: 800 }}>
          TA
        </span>
        <h1>Reset your password</h1>
        <p>Enter your email or username and we will create a reset link valid for 30 minutes.</p>
      </div>
      <div className="login-panel">
        <div className="login-card card">
          <div className="card-body" style={{ padding: 28 }}>
            {sent ? (
              <div className="stack" style={{ gap: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Check your inbox</div>
                <p className="small muted" style={{ margin: 0 }}>
                  If an account matches, a reset link was sent by email and added to your in-app
                  notifications. The link expires in 30 minutes.
                </p>
                <Link to="/login" className="btn btn-primary btn-block">
                  Back to sign in
                </Link>
              </div>
            ) : (
              <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
                <div className="field">
                  <label>Email or username</label>
                  <input
                    className="input"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="you@agency.com"
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </div>
                {error ? (
                  <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: '9px 12px', borderRadius: 8, fontSize: 13 }}>
                    {error}
                  </div>
                ) : null}
                <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                  {busy ? 'Sending…' : 'Send reset link'}
                </button>
                <Link to="/login" className="small muted" style={{ textAlign: 'center' }}>
                  Back to sign in
                </Link>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
