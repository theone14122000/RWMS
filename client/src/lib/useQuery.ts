import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get } from '../api/client';

interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useQuery<T>(url: string | null, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let active = true;
    setLoading(true);
    setError(null);

    get<T>(url)
      .then((res) => {
        if (!active) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active || (err as any)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load data');
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);

  return { data, loading, error, reload };
}
