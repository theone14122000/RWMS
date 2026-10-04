import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  title,
  children,
  footer,
  onClose,
  size = 'md',
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  children,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm right" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options
        ? createPortal(
            <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
              <div className="modal sm" role="alertdialog" aria-modal="true">
                <div className="modal-head">
                  <h3>{options.title}</h3>
                </div>
                <div className="modal-body">
                  {typeof options.message === 'string' ? <p>{options.message}</p> : options.message}
                </div>
                <div className="modal-foot">
                  <button type="button" className="btn" onClick={() => close(false)}>
                    {options.cancelLabel ?? 'Cancel'}
                  </button>
                  <button
                    type="button"
                    className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick={() => close(true)}
                    autoFocus
                  >
                    {options.confirmLabel ?? 'Confirm'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx.confirm;
}
