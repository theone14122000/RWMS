import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { patch, post } from '../api/client';
import { Avatar } from '../ui/atoms';
import { useToast } from '../ui/Toast';

interface NotificationRow {
  id: number;
  title: string;
  body?: string | null;
  link?: string | null;
  read_at?: string | null;
  created_at: string;
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/leads\/\d/, 'Lead details'],
  [/^\/leads/, 'Leads'],
  [/^\/follow-ups/, 'Follow-ups'],
  [/^\/customers/, 'Customers'],
  [/^\/calls/, 'Calls & recordings'],
  [/^\/quotations/, 'Quotations'],
  [/^\/bookings/, 'Bookings'],
  [/^\/invoices/, 'Invoices'],
  [/^\/reports/, 'Reports & data'],
  [/^\/analytics/, 'Analytics'],
  [/^\/automation/, 'Automation'],
  [/^\/workers/, 'Workers'],
  [/^\/workload/, 'Daily workload'],
  [/^\/settings/, 'Settings'],
  [/^\/audit/, 'Audit logs'],
  [/^\/activity/, 'My activity'],
  [/^\/profile/, 'My profile'],
  [/^\/$/, 'Dashboard'],
];

export default function Layout() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const { data: notifData, reload: reloadNotifs } = useQuery<{ data: NotificationRow[]; meta?: any }>(
    '/api/notifications?limit=8',
  );
  const unread = Number(notifData?.meta?.unread ?? 0);

  useEffect(() => {
    setSidebarOpen(false);
    setNotifOpen(false);
    setUserOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pageTitle = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? 'Travel Agency CRM';

  const isAdmin = user?.role === 'ADMIN';
  const nav: Array<{ to: string; label: string; icon: string; show: boolean; end?: boolean }> = [
    { to: '/', label: 'Dashboard', icon: '▦', show: true, end: true },
    { to: '/leads', label: isAdmin ? 'Leads' : 'My Leads', icon: '◈', show: true },
    { to: '/follow-ups', label: 'Follow-ups', icon: '◷', show: true },
    { to: '/calls', label: 'Calls', icon: '☎', show: can('calls:read_all') || can('calls:read_own') },
    { to: '/quotations', label: 'Quotations', icon: '✎', show: can('quotations:read_all') || can('quotations:read_own') },
    { to: '/bookings', label: 'Bookings', icon: '✈', show: can('bookings:read_all') || can('bookings:read_own') },
    { to: '/invoices', label: 'Invoices', icon: '§', show: can('invoices:read_all') || can('invoices:read_own') },
    { to: '/customers', label: 'Customers', icon: '☺', show: can('customers:read_all') || can('customers:read_own') },
    { to: '/reports', label: 'Reports & data', icon: '⇩', show: can('reports:read') || can('exports:run') },
    { to: '/analytics', label: 'Analytics', icon: '◔', show: can('analytics:read') },
    { to: '/automation', label: 'Automation', icon: '⟳', show: can('automation:manage') },
    { to: '/workers', label: 'Workers', icon: '☗', show: isAdmin },
    { to: '/workload', label: 'Daily workload', icon: '▤', show: isAdmin },
    { to: '/activity', label: 'My activity', icon: '↻', show: !isAdmin },
    { to: '/settings', label: 'Settings', icon: '⚙', show: isAdmin },
    { to: '/audit', label: 'Audit logs', icon: '☰', show: isAdmin },
  ].filter((n) => n.show);

  return (
    <div className="app-shell">
      <div className={`mobile-overlay${sidebarOpen ? ' show' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <span className="logo">TA</span>
          <span>Travel CRM</span>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-section">Workspace</div>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="row" style={{ gap: 9 }}>
            <Avatar name={user?.name} dark />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.name}
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b' }}>{isAdmin ? 'Admin / Owner' : 'Worker'}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn-ghost btn-sm hamburger" onClick={() => setSidebarOpen(true)} aria-label="Menu">
            ☰
          </button>
          <h1>{pageTitle}</h1>
          <span className="spacer" />

          <div style={{ position: 'relative' }} ref={notifRef}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setNotifOpen((v) => !v);
                setUserOpen(false);
              }}
              aria-label="Notifications"
              style={{ position: 'relative' }}
            >
              ◉
              {unread > 0 ? (
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    background: 'var(--danger)',
                    color: '#fff',
                    fontSize: 9.5,
                    fontWeight: 700,
                    borderRadius: 999,
                    minWidth: 15,
                    height: 15,
                    display: 'grid',
                    placeItems: 'center',
                    padding: '0 3px',
                  }}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </button>
            {notifOpen ? (
              <div
                className="card"
                style={{ position: 'absolute', right: 0, top: 40, width: 330, zIndex: 60, boxShadow: 'var(--shadow-lg)' }}
              >
                <div className="card-head">
                  <h3>Notifications</h3>
                  <div className="right">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await post('/api/notifications/read-all');
                          reloadNotifs();
                        } catch {
                          toast.push('error', 'Could not mark notifications as read');
                        }
                      }}
                    >
                      Mark all read
                    </button>
                  </div>
                </div>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {!notifData?.data?.length ? (
                    <div className="empty" style={{ padding: 24 }}>
                      <p>No notifications yet</p>
                    </div>
                  ) : (
                    notifData.data.map((n) => (
                      <div
                        key={n.id}
                        style={{
                          padding: '10px 14px',
                          borderBottom: '1px solid var(--border)',
                          background: n.read_at ? 'transparent' : 'var(--primary-50)',
                          cursor: n.link ? 'pointer' : 'default',
                        }}
                        onClick={async () => {
                          if (!n.read_at) {
                            try {
                              await patch(`/api/notifications/${n.id}/read`);
                              reloadNotifs();
                            } catch {
                              toast.push('error', 'Could not mark the notification as read');
                            }
                          }
                          if (n.link) {
                            navigate(n.link);
                            setNotifOpen(false);
                          }
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{n.title}</div>
                        {n.body ? <div className="small muted">{n.body}</div> : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ position: 'relative' }} ref={userRef}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setUserOpen((v) => !v);
                setNotifOpen(false);
              }}
            >
              <Avatar name={user?.name} />
              <span className="hide-sm">{user?.name}</span>
            </button>
            {userOpen ? (
              <div
                className="card"
                style={{ position: 'absolute', right: 0, top: 40, width: 230, zIndex: 60, boxShadow: 'var(--shadow-lg)' }}
              >
                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 650 }}>{user?.name}</div>
                  <div className="small muted">{user?.email}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className="badge badge-blue">{isAdmin ? 'ADMIN' : 'WORKER'}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="nav-item"
                  style={{ margin: 6, color: 'var(--text-2)' }}
                  onClick={() => {
                    setUserOpen(false);
                    navigate('/profile');
                  }}
                >
                  <span className="icon">☺</span> My profile
                </button>
                <button
                  type="button"
                  className="nav-item"
                  style={{ margin: 6, color: 'var(--text-2)' }}
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  <span className="icon">⏻</span> Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
