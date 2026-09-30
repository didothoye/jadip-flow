import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : undefined;
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className="value" style={{ color }}>{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Badge({ tone, children, title }: { tone?: 'good' | 'warn' | 'bad' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone ?? ''}`} title={title}>{children}</span>;
}

export function PageHead({ title, sub, crumb, actions }: { title: ReactNode; sub?: ReactNode; crumb?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumb && <div className="breadcrumb">{crumb}</div>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export const Loading = () => <div className="spinner" role="status" aria-label="Chargement" />;
export const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="alert error" role="alert">{error}</div> : null);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** Affiche le chargement / l'erreur, sinon le contenu. */
export function Async<T>({ data, error, loading, children }: { data: T | null; error: string | null; loading: boolean; children: (d: T) => ReactNode }) {
  if (error && !data) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  return <>{children(data)}</>;
}

export function Modal({ title, children, onClose, actions }: { title: ReactNode; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true">
      <div className="modal" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="track" />
    </label>
  );
}

// ---------------------------------------------------------------- confirmations et notifications éphémères

interface ConfirmOpts { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; input?: { label: string; placeholder?: string } }
interface UiCtx { toast: (msg: string, kind?: 'ok' | 'error') => void; confirm: (o: ConfirmOpts) => Promise<{ ok: boolean; value?: string }> }
const Ctx = createContext<UiCtx>(null as any);
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOpts & { resolve: (r: { ok: boolean; value?: string }) => void }) | null>(null);
  const [value, setValue] = useState('');
  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<{ ok: boolean; value?: string }>((resolve) => { setValue(''); setDialog({ ...o, resolve }); }), []);
  const close = (ok: boolean) => { dialog?.resolve({ ok, value }); setDialog(null); };
  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      {dialog && (
        <Modal title={dialog.title} onClose={() => close(false)} actions={<>
          <button className="btn" onClick={() => close(false)}>Annuler</button>
          <button className={`btn ${dialog.danger ? 'danger solid' : 'primary'}`} onClick={() => close(true)} autoFocus>{dialog.confirmLabel ?? 'Confirmer'}</button>
        </>}>
          <div>{dialog.message}</div>
          {dialog.input && (
            <label className="field" style={{ marginTop: '.8rem' }}>{dialog.input.label}
              <input value={value} placeholder={dialog.input.placeholder} onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
        </Modal>
      )}
      <div className="toast-zone" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  );
}

/** Exécute une action asynchrone avec retour visuel (message de succès ou d'erreur). */
export function useAction() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e: any) {
      toast(e.message ?? 'Erreur', 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, 'good' | 'bad' | 'warn' | 'info' | undefined]> = {
    success: ['Réussie', 'good'], error: ['Échec', 'bad'], crashed: ['Plantage', 'bad'], running: ['En cours', 'info'],
    waiting: ['En attente', 'warn'], canceled: ['Annulée', undefined], new: ['Nouvelle', undefined],
  };
  const [label, tone] = map[status] ?? [status, undefined];
  return <Badge tone={tone}>{label}</Badge>;
}

export function HealthBadge({ status }: { status: string }) {
  const map: Record<string, [string, 'good' | 'bad' | 'warn' | undefined]> = { ok: ['Opérationnelle', 'good'], degraded: ['Dégradée', 'warn'], down: ['Hors service', 'bad'], unknown: ['Inconnue', undefined] };
  const [label, tone] = map[status] ?? [status, undefined];
  return <Badge tone={tone}><span className="dot" />{label}</Badge>;
}
