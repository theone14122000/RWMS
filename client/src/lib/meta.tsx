import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from './useQuery';

export interface LeadStatus {
  id: number;
  code: string;
  name: string;
  category: 'OPEN' | 'WON' | 'LOST' | 'NEUTRAL';
  color: string;
  is_active: number;
  sort_order: number;
}

export interface LeadSource {
  id: number;
  name: string;
  is_active: number;
  sort_order: number;
}

interface MetaResponse {
  statuses: LeadStatus[];
  sources: LeadSource[];
  options: Record<string, any>;
  roles: Array<{ id: number; code: string; name: string; description?: string }>;
  permissions: Array<{ id: number; code: string; name: string; category: string }>;
  follow_up_board: Array<{ key: string; label: string }>;
}

interface MetaContextValue {
  statuses: LeadStatus[];
  sources: LeadSource[];
  options: Record<string, any>;
  roles: MetaResponse['roles'];
  board: MetaResponse['follow_up_board'];
  tripTypes: string[];
  requirements: string[];
  priorities: Array<{ value: string; label: string; color: string }>;
  followUpTypes: string[];
  currencies: string[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  statusByCode: (code?: string | null) => LeadStatus | undefined;
}

const MetaContext = createContext<MetaContextValue | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const { data: payload, loading, error, reload } = useQuery<{ data: MetaResponse }>('/api/meta');
  const data = payload?.data;

  const value = useMemo<MetaContextValue>(() => {
    const options = data?.options ?? {};
    return {
      statuses: data?.statuses ?? [],
      sources: data?.sources ?? [],
      options,
      roles: data?.roles ?? [],
      board: data?.follow_up_board ?? [],
      tripTypes: options.trip_types ?? [],
      requirements: options.requirements_options ?? [],
      priorities: options.priorities ?? [],
      followUpTypes: options.follow_up_types ?? ['Call', 'WhatsApp', 'Email', 'Meeting'],
      currencies: options.currencies ?? ['INR'],
      loading,
      error,
      reload,
      statusByCode: (code?: string | null) => (code ? data?.statuses.find((s) => s.code === code) : undefined),
    };
  }, [data, loading, error, reload]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

export function useMeta() {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error('useMeta must be used inside MetaProvider');
  return ctx;
}
