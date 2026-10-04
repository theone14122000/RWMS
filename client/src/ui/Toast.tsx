import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);

  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = seq.current++;
    setToasts((prev) => [...prev, { id, kind, title, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : t.kind === 'success' ? 'success' : ''}`}>
            <div>
              <div className="t-title">{t.title}</div>
              {t.message ? <div className="t-msg">{t.message}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
