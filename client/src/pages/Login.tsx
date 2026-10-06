import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { useToast } from '../ui/Toast';

/** Static marketing copy — the page itself never talks to the database. */
const HEADLINE_WORDS = ['leads', 'follow-ups', 'bookings', 'team'] as const;

const FEATURES = [
  {
    title: 'Lead pipeline',
    body: 'Assign, reassign and trace every lead with a complete history.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 19V5m0 14h16M8 15l3.5-4 3 2.5L20 7" />
      </svg>
    ),
  },
  {
    title: 'Follow-up board',
    body: 'A daily board that never lets an overdue conversation slip.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M3.5 9.5h17M8 3.5v3m8-3v3m-7 8l2.5 2.5L16.5 11" />
      </svg>
    ),
  },
  {
    title: 'Calls & recordings',
    body: 'Log calls, attach recordings and auto-create the next follow-up.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h4l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2L20 15v4a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z" />
      </svg>
    ),
  },
  {
    title: 'Role-based access',
    body: 'Admins see everything; workers only see their own book of business.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5l7 2.8v5.2c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6.3l7-2.8z" />
        <path d="M9 12l2.2 2.2L15.5 10" />
      </svg>
    ),
  },
] as const;

function useRotator(words: readonly string[], ms = 2400): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setIndex((v) => (v + 1) % words.length), ms);
    return () => window.clearInterval(id);
  }, [words.length, ms]);
  return words[index];
}

function useCountUp(target: number, ms = 1100): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export default function Login() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotatingWord = useRotator(HEADLINE_WORDS);
  const statViews = useCountUp(16);
  const statRoles = useCountUp(2);
  const statAudited = useCountUp(100);

  if (!loading && user) return <Navigate to="/" replace />;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    e.currentTarget.style.setProperty('--mx', x.toFixed(3));
    e.currentTarget.style.setProperty('--my', y.toFixed(3));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const logged = await login(identifier.trim(), password);
      toast.push('success', `Welcome back, ${logged.name.split(' ')[0]}`);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && !from.startsWith('/login') ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing" onMouseMove={onMove}>
      <div className="landing-aura" aria-hidden="true">
        <span className="landing-orb landing-orb-a" />
        <span className="landing-orb landing-orb-b" />
        <span className="landing-orb landing-orb-c" />
        <span className="landing-grid" />
      </div>

      <main className="landing-shell">
        <section className="landing-copy">
          <div className="landing-brand">
            <span className="landing-logo">TA</span>
            Travel Agency CRM
          </div>

          <span className="landing-eyebrow">All-in-one workspace</span>

          <h1>
            Run your <span className="landing-rot" key={rotatingWord}>{rotatingWord}</span>
            <br />
            without dropping a single detail.
          </h1>

          <p className="landing-sub">
            Assign leads, track every customer conversation and keep the whole team on
            one board — from first enquiry to final invoice.
          </p>

          <div className="landing-features">
            {FEATURES.map((f, i) => (
              <article className="landing-feat" key={f.title} style={{ animationDelay: `${0.15 + i * 0.09}s` }}>
                <span className="landing-feat-ico">{f.icon}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="landing-stats">
            <div>
              <strong>{statViews}+</strong>
              <em>workspace views</em>
            </div>
            <div>
              <strong>{statRoles}</strong>
              <em>focused roles</em>
            </div>
            <div>
              <strong>{statAudited}%</strong>
              <em>actions audited</em>
            </div>
          </div>
        </section>

        <section className="landing-auth">
          <form className="landing-card" onSubmit={submit}>
            <div className="landing-card-head">
              <h2>Welcome back</h2>
              <p>Sign in to continue to your workspace.</p>
            </div>

            <div className="stack" style={{ gap: 14 }}>
              <div className="field">
                <label htmlFor="li-identifier">Email or username</label>
                <input
                  id="li-identifier"
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
                <label htmlFor="li-password">Password</label>
                <div className="landing-pass">
                  <input
                    id="li-password"
                    className="input"
                    type={reveal ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="landing-eye"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={reveal ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {reveal ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 4l16 16M10.6 10.7a2 2 0 0 0 2.7 2.8M9.4 5.7A9.4 9.4 0 0 1 12 5.4c5 0 8.6 4 9.6 6.6a12.8 12.8 0 0 1-3 4.1M6.2 7.4A12.6 12.6 0 0 0 2.4 12c1 2.6 4.6 6.6 9.6 6.6 1.3 0 2.5-.3 3.6-.7" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M2.4 12C3.4 9.4 7 5.4 12 5.4s8.6 4 9.6 6.6c-1 2.6-4.6 6.6-9.6 6.6S3.4 14.6 2.4 12z" />
                        <circle cx="12" cy="12" r="2.6" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {error ? (
                <div className="landing-err" role="alert">
                  {error}
                </div>
              ) : null}

              <button type="submit" className="btn btn-primary btn-block landing-go" disabled={busy}>
                {busy ? (
                  <>
                    <span className="landing-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="landing-arrow">
                      <path d="M5 12h14m-6-6l6 6-6 6" />
                    </svg>
                  </>
                )}
              </button>

              <Link to="/forgot-password" className="landing-forgot">
                Forgot password?
              </Link>
            </div>
          </form>
        </section>
      </main>

      <footer className="landing-foot">© 2026 Travel Agency CRM · Built for travel teams</footer>
    </div>
  );
}
