import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, onUnauthorized, post } from '../api/client';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  role: 'ADMIN' | 'WORKER';
  status: string;
  permissions: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await get<{ data: AuthUser }>('/api/auth/me');
      setUser(res.data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
      }),
    [],
  );

  const login = useCallback(async (identifier: string, password: string) => {
    const res = await post<{ data: AuthUser }>('/api/auth/login', { identifier, password });
    setUser(res.data);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  const can = useCallback(
    (permission: string) => Boolean(user?.permissions.includes(permission)) || user?.role === 'ADMIN',
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh, can }),
    [user, loading, login, logout, refresh, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
