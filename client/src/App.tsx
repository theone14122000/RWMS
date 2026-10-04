import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Layout from './layout/Layout';
import { LoadingState } from './ui/atoms';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import FollowUps from './pages/FollowUps';
import Customers from './pages/Customers';
import Workers from './pages/Workers';
import Workload from './pages/Workload';
import Settings from './pages/Settings';
import Calls from './pages/Calls';
import Quotations from './pages/Quotations';
import Bookings from './pages/Bookings';
import Reports from './pages/Reports';
import Analytics from './pages/Analytics';
import Automation from './pages/Automation';
import AuditLogs from './pages/AuditLogs';
import Activity from './pages/Activity';
import NotFound from './pages/NotFound';

function Protected({ children, adminOnly }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <LoadingState label="Checking your session…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (adminOnly && user.role !== 'ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/leads/:id" element={<LeadDetail />} />
        <Route path="/follow-ups" element={<FollowUps />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/quotations" element={<Quotations />} />
        <Route path="/bookings" element={<Bookings />} />
        <Route path="/reports" element={<Reports />} />
        <Route
          path="/analytics"
          element={
            <Protected adminOnly>
              <Analytics />
            </Protected>
          }
        />
        <Route
          path="/automation"
          element={
            <Protected adminOnly>
              <Automation />
            </Protected>
          }
        />
        <Route
          path="/workers"
          element={
            <Protected adminOnly>
              <Workers />
            </Protected>
          }
        />
        <Route
          path="/workload"
          element={
            <Protected adminOnly>
              <Workload />
            </Protected>
          }
        />
        <Route
          path="/settings"
          element={
            <Protected adminOnly>
              <Settings />
            </Protected>
          }
        />
        <Route
          path="/audit"
          element={
            <Protected adminOnly>
              <AuditLogs />
            </Protected>
          }
        />
        <Route path="/activity" element={<Activity />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
