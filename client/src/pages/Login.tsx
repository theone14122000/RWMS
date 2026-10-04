import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { useToast } from '../ui/Toast';

export default function Login() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const logged = await login(identifier.trim(), password);
      toast.push('success', `Welcome back, ${logged.name.split(' ')[0]}`);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="row" style={{ gap: 10 }}>
          <span className="logo" style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(255,255,255,0.14)', display: 'grid', placeItems: 'center', fontWeight: 800 }}>
            TA
          </span>
          <span style={{ fontWeight: 750, fontSize: 17 }}>Travel Agency CRM</span>
        </div>
        <h1>Run your travel leads, follow-ups and team from one place.</h1>
        <p>Assign leads, track every customer conversation and never miss a follow-up again.</p>
        <ul>
          <li>Lead assignment &amp; complete history</li>
          <li>Daily follow-up board with overdue tracking</li>
          <li>Worker workload and conversion dashboards</li>
          <li>Role-based access for admins and workers</li>
        </ul>
      </div>
      <div className="login-panel">
        <div className="login-card card">
          <div className="card-body" style={{ padding: 28 }}>
            <div className="brand">
              <span className="logo" style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,#3b82f6,#06b6d4)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 800 }}>
                TA
              </span>
              Sign in to your workspace
            </div>

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
              <div className="field">
                <label>Password</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
              {error ? (
                <div style={{ background: 'var(--danger-50)', color: 'var(--danger)', padding: '9px 12px', borderRadius: 8, fontSize: 13 }}>
                  {error}
                </div>
              ) : null}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="divider" />
            <div className="small muted">
              Default admin: <span className="mono">admin@travelcrm.local</span> · <span className="mono">Admin@1234!</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
