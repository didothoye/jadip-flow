/** Briques communes aux pages de l'agence : onglets, badges, listes d'erreurs / d'exécutions, bascule d'état, etc. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { CATEGORY_LABELS, fmtDateTime, fmtMs, fmtNum, fmtPct, fromNow, TICKET_STATUS } from '../../lib/format';
import { Badge, Empty, ErrorBox, Loading, StatusBadge, Switch, useAction, useUi } from '../../components/ui';
import './agency.css';

// ---------------------------------------------------------------- petits utilitaires

/** Convertit une saisie (virgule acceptée) en nombre, ou null si vide. */
export const toNum = (s: string): number | null => {
  const t = s.trim().replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
export const numStr = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

export const rateTone = (r: number | null | undefined): 'good' | 'warn' | 'bad' | undefined =>
  r == null ? undefined : r >= 0.95 ? 'good' : r >= 0.85 ? 'warn' : 'bad';

export function Rate({ value }: { value: number | null | undefined }) {
  const tone = rateTone(value);
  const color = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : undefined;
  return <span style={{ color, fontWeight: 600 }}>{fmtPct(value)}</span>;
}

/** Date relative avec la date exacte au survol. */
export const Ago = ({ at, empty = 'jamais' }: { at: string | null | undefined; empty?: string }) =>
  at ? <span title={fmtDateTime(at)} className="nowrap">{fromNow(at)}</span> : <span className="muted">{empty}</span>;

export function Initials({ name }: { name: string }) {
  const s = name.replace(/\(.*?\)/g, '').split(/[\s—-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return <span className="ag-avatar" aria-hidden="true">{s || '?'}</span>;
}

// ---------------------------------------------------------------- onglets (mémorisés dans l'URL)

export function useTab<T extends string>(keys: readonly T[], def: T, param = 'onglet'): [T, (t: T) => void] {
  const [sp, setSp] = useSearchParams();
  const cur = sp.get(param) as T | null;
  const value = cur && keys.includes(cur) ? cur : def;
  const set = useCallback((t: T) => {
    setSp((p) => { const n = new URLSearchParams(p); if (t === def) n.delete(param); else n.set(param, t); return n; }, { replace: true });
  }, [setSp, def, param]);
  return [value, set];
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, ReactNode][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function PillTabs<T extends string>({ options, value, onChange, label }: { options: [T, ReactNode][]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="pill-tabs" role="group" aria-label={label}>
      {options.map(([k, l]) => <button key={k} type="button" className={value === k ? 'active' : ''} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

// ---------------------------------------------------------------- badges métier

const CAT_TONE: Record<string, 'bad' | 'warn' | 'info' | undefined> = { auth: 'bad', rate_limit: 'warn', network: 'info', data: 'warn', logic: undefined };
export const CategoryBadge = ({ category }: { category: string | null | undefined }) =>
  category ? <Badge tone={CAT_TONE[category]}>{CATEGORY_LABELS[category] ?? category}</Badge> : <span className="muted small">Non classée</span>;

export function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, [string, 'bad' | 'warn' | 'info']> = { critical: ['Critique', 'bad'], warning: ['Avertissement', 'warn'], info: ['Information', 'info'] };
  const [l, t] = map[severity] ?? [severity, 'info'];
  return <Badge tone={t}>{l}</Badge>;
}

export function AlertStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, 'bad' | 'warn' | 'good' | undefined]> = { open: ['Ouverte', 'bad'], acknowledged: ['Prise en compte', 'warn'], resolved: ['Résolue', 'good'] };
  const [l, t] = map[status] ?? [status, undefined];
  return <Badge tone={t}>{l}</Badge>;
}

export function TicketStatusBadge({ status }: { status: string }) {
  const tone: Record<string, 'info' | 'warn' | 'good' | undefined> = { new: 'info', in_progress: 'warn', waiting_client: undefined, done: 'good', closed: undefined };
  return <Badge tone={tone[status]}>{TICKET_STATUS[status] ?? status}</Badge>;
}

export function RiskBadge({ risks }: { risks: string[] }) {
  return risks.length ? <Badge tone="bad" title={risks.join(' · ')}>À risque</Badge> : <Badge tone="good">Sain</Badge>;
}

export const SOURCE_LABELS: Record<string, string> = { web: 'Web', api: 'API', mcp: 'MCP', system: 'Système' };

export const ACTION_LABELS: Record<string, string> = { activate: 'Activation', deactivate: 'Désactivation', pause: 'Mise en pause', retry: 'Relance' };
export function ActionResultBadge({ result }: { result: string }) {
  const map: Record<string, [string, 'good' | 'bad' | 'warn']> = { ok: ['Réussie', 'good'], error: ['Erreur', 'bad'], refused: ['Refusée', 'warn'] };
  const [l, t] = map[result] ?? [result, 'warn'];
  return <Badge tone={t}>{l}</Badge>;
}

export const EVENT_LABELS: Record<string, string> = {
  created: 'Détecté dans n8n', renamed: 'Renommé', deleted: 'Supprimé dans n8n', restored: 'Restauré', activated: 'Activé', deactivated: 'Désactivé', assigned: 'Rattachement client modifié',
};

// ---------------------------------------------------------------- clients (listes de choix)

export interface ClientLite { id: string; code: string; name: string; archived_at: string | null; is_internal: boolean }
export function useClientList() {
  const r = useApi<ClientLite[]>('/api/admin/clients');
  return { clients: (r.data ?? []).filter((c) => !c.archived_at), all: r.data ?? [], loading: r.loading };
}

export function ClientSelect({ value, onChange, clients, allLabel = 'Tous les clients', label = 'Client' }: { value: string; onChange: (v: string) => void; clients: ClientLite[]; allLabel?: string | null; label?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allLabel !== null && <option value="">{allLabel}</option>}
      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- copie dans le presse-papiers

export function CopyField({ value, label }: { value: string; label: string }) {
  const { toast } = useUi();
  const ref = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast('Copié dans le presse-papiers.'); } catch { ref.current?.select(); toast('Sélectionnez puis copiez le texte (Ctrl+C).', 'error'); }
  };
  return (
    <label className="field">{label}
      <span className="ag-copy">
        <input ref={ref} readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn" onClick={copy}>Copier</button>
      </span>
    </label>
  );
}

export function JsonDetail({ value }: { value: unknown }) {
  if (value == null || (typeof value === 'object' && !Object.keys(value as object).length)) return <span className="muted">—</span>;
  return (
    <details className="ag-details">
      <summary>Afficher</summary>
      <pre className="ag-json">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

// ---------------------------------------------------------------- actions sur les exécutions

/** Relance d'une exécution en échec (avec confirmation ; gère l'absence de prise en charge par n8n). */
export function useRetry(onDone?: () => void) {
  const { confirm, toast } = useUi();
  const [busyId, setBusyId] = useState<number | null>(null);
  const retry = async (e: { id: number; n8n_execution_id?: string; workflow_display_name?: string; workflow_name?: string }) => {
    const r = await confirm({ title: 'Relancer l’exécution', message: <>L’exécution n° {e.n8n_execution_id ?? e.id}{e.workflow_display_name || e.workflow_name ? <> de « {e.workflow_display_name ?? e.workflow_name} »</> : null} sera relancée dans n8n avec les mêmes données d’entrée.</>, confirmLabel: 'Relancer' });
    if (!r.ok) return;
    setBusyId(e.id);
    try {
      const res = await api.post<{ newExecutionId: string | null }>(`/api/admin/executions/${e.id}/retry`);
      toast(res.newExecutionId ? `Exécution relancée (nouvelle exécution n° ${res.newExecutionId}).` : 'Exécution relancée.');
      onDone?.();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 501) toast(`${err.message}`, 'error');
      else toast(err.message ?? 'Relance impossible.', 'error');
    } finally {
      setBusyId(null);
    }
  };
  return { retry, busyId };
}

export function useMarkHandled(onDone?: () => void) {
  const { run, busy } = useAction();
  const mark = async (ids: number[], handled = true) => {
    const r = await run(() => api.post<{ updated: number }>('/api/admin/executions/handled', { ids, handled }),
      handled ? (ids.length > 1 ? `${ids.length} erreurs marquées comme traitées.` : 'Erreur marquée comme traitée.') : 'Erreur remise à traiter.');
    if (r) onDone?.();
  };
  return { mark, busy };
}

export interface ErrorRow {
  id: number; n8n_execution_id: string; status: string; started_at: string; error_node: string | null; error_message: string | null; error_category: string | null;
  handled_at: string | null; workflow_id: string; workflow_name: string; workflow_display_name: string; client_id: string | null; client_name: string | null; instance_name?: string;
}

/** Tableau d'erreurs (avec sélection multiple optionnelle). */
export function ErrorTable({ rows, onChanged, showWorkflow = true, showClient = true, selectable = false, selected, setSelected, empty = 'Aucune erreur.' }: {
  rows: ErrorRow[]; onChanged: () => void; showWorkflow?: boolean; showClient?: boolean; selectable?: boolean;
  selected?: Set<number>; setSelected?: (s: Set<number>) => void; empty?: ReactNode;
}) {
  const { retry, busyId } = useRetry(onChanged);
  const { mark, busy } = useMarkHandled(onChanged);
  if (!rows.length) return <Empty>{empty}</Empty>;
  const unhandled = rows.filter((r) => !r.handled_at);
  const allSel = selectable && selected && unhandled.length > 0 && unhandled.every((r) => selected.has(r.id));
  const toggle = (id: number) => { if (!selected || !setSelected) return; const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th style={{ width: 32 }}><input type="checkbox" aria-label="Tout sélectionner" checked={!!allSel}
              onChange={(e) => setSelected?.(e.target.checked ? new Set(unhandled.map((r) => r.id)) : new Set())} /></th>}
            <th>Date</th>
            {showWorkflow && <th>{showClient ? 'Workflow / client' : 'Workflow'}</th>}
            {showClient && !showWorkflow && <th>Client</th>}
            <th>Nœud</th><th>Catégorie</th><th>Message</th><th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.handled_at ? 'muted-row' : ''}>
              {selectable && <td>{!e.handled_at && <input type="checkbox" aria-label={`Sélectionner l’erreur ${e.n8n_execution_id}`} checked={!!selected?.has(e.id)} onChange={() => toggle(e.id)} />}</td>}
              <td className="nowrap"><Ago at={e.started_at} /><span className="ag-sub">n° {e.n8n_execution_id}</span></td>
              {showWorkflow && <td style={{ minWidth: 170 }}><Link to={`/agence/workflows/${e.workflow_id}`} title={e.workflow_name}>{e.workflow_display_name}</Link>
                {showClient && <span className="ag-sub">{e.client_id ? <Link to={`/agence/clients/${e.client_id}`}>{e.client_name}</Link> : 'Non rattaché'}</span>}</td>}
              {showClient && !showWorkflow && <td>{e.client_id ? <Link to={`/agence/clients/${e.client_id}`}>{e.client_name}</Link> : <span className="muted">Non rattaché</span>}</td>}
              <td>{e.error_node ?? <span className="muted">—</span>}</td>
              <td><CategoryBadge category={e.error_category} /></td>
              <td style={{ minWidth: 260 }}><span className="ag-clamp small" title={e.error_message ?? ''}>{e.error_message ?? <span className="muted">Détail en cours de récupération</span>}</span></td>
              <td className="actions">
                {e.handled_at ? (
                  <><Badge tone="good" title={`Traitée le ${fmtDateTime(e.handled_at)}`}>Traitée</Badge>{' '}
                    <button className="btn small ghost" disabled={busy} onClick={() => mark([e.id], false)}>Rouvrir</button></>
                ) : (
                  <>
                    <button className="btn small" disabled={busyId === e.id} onClick={() => retry(e)}>{busyId === e.id ? 'Relance…' : 'Relancer'}</button>
                    <button className="btn small" disabled={busy} onClick={() => mark([e.id])}>Marquer comme traitée</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- listes paginées par curseur

export function useCursorList<T>(url: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const fetchPage = useCallback(async (cursor: string | null) => {
    if (!url) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const u = cursor ? `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : url;
      const r = await api.get<{ items: T[]; nextCursor: string | null }>(u);
      if (n !== seq.current) return;
      setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
      setNext(r.nextCursor);
      setError(null);
    } catch (e: any) {
      if (n === seq.current) setError(e.message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => { setItems([]); setNext(null); fetchPage(null); }, [fetchPage]);
  return { items, next, loading, error, more: () => fetchPage(next), reload: () => fetchPage(null) };
}

export interface ExecRow {
  id: number; n8n_execution_id: string; status: string; mode: string | null; started_at: string; stopped_at: string | null; duration_ms: number | null;
  error_node: string | null; error_message: string | null; error_category: string | null; retry_of: string | null; handled_at: string | null;
  workflow_id: string; workflow_display_name: string; workflow_name: string; client_id: string | null;
}

const MODE_LABELS: Record<string, string> = { trigger: 'Déclencheur', webhook: 'Webhook', manual: 'Manuel', retry: 'Relance', integrated: 'Intégré', cli: 'Ligne de commande', internal: 'Interne', error: 'Gestion d’erreur', evaluation: 'Évaluation' };

/** Tableau d'exécutions paginé (« Charger plus »). */
export function ExecutionTable({ list, showWorkflow = true, clientNames, onChanged }: {
  list: ReturnType<typeof useCursorList<ExecRow>>; showWorkflow?: boolean; clientNames?: Record<string, string>; onChanged?: () => void;
}) {
  const { retry, busyId } = useRetry(onChanged ?? list.reload);
  if (list.error && !list.items.length) return <ErrorBox error={list.error} />;
  if (list.loading && !list.items.length) return <Loading />;
  if (!list.items.length) return <Empty>Aucune exécution pour ces critères.</Empty>;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Début</th>{showWorkflow && <th>Workflow</th>}{clientNames && <th>Client</th>}<th>Statut</th><th>Mode</th><th className="num">Durée</th><th>Erreur</th><th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtDateTime(e.started_at)}<span className="ag-sub">n° {e.n8n_execution_id}{e.retry_of ? ` · relance de ${e.retry_of}` : ''}</span></td>
                {showWorkflow && <td><Link to={`/agence/workflows/${e.workflow_id}`}>{e.workflow_display_name}</Link></td>}
                {clientNames && <td>{e.client_id ? <Link to={`/agence/clients/${e.client_id}`}>{clientNames[e.client_id] ?? 'Client'}</Link> : <span className="muted">Non rattaché</span>}</td>}
                <td><StatusBadge status={e.status} /></td>
                <td className="small">{e.mode ? MODE_LABELS[e.mode] ?? e.mode : '—'}</td>
                <td className="num">{fmtMs(e.duration_ms)}</td>
                <td>
                  {e.error_message || e.error_category ? (
                    <><CategoryBadge category={e.error_category} />{e.error_node && <span className="ag-sub">Nœud : {e.error_node}</span>}
                      <span className="ag-clamp small" title={e.error_message ?? ''}>{e.error_message}</span></>
                  ) : <span className="muted">—</span>}
                </td>
                <td className="actions">
                  {['error', 'crashed'].includes(e.status) && (
                    <button className="btn small" disabled={busyId === e.id} onClick={() => retry(e)}>Relancer</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={list.error} />
      <div className="ag-more">
        {list.next ? <button className="btn" onClick={list.more} disabled={list.loading}>{list.loading ? 'Chargement…' : 'Charger plus'}</button>
          : <span className="muted small">{list.items.length} exécution(s) affichée(s) · fin de la liste</span>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- activation / désactivation d'un workflow

export interface WfToggle { id: string; name: string; display_name?: string | null; active: boolean; is_locked: boolean; deleted_at?: string | null }

export function WorkflowSwitch({ wf, onChanged, withLabel = false }: { wf: WfToggle; onChanged: (active: boolean) => void; withLabel?: boolean }) {
  const { confirm, toast } = useUi();
  const [busy, setBusy] = useState(false);
  const name = wf.display_name || wf.name;
  const lockedOn = wf.is_locked && wf.active;
  const change = async (on: boolean) => {
    const r = await confirm(on
      ? { title: 'Activer le workflow', message: <>« {name} » sera activé dans n8n et recommencera à se déclencher automatiquement.</>, confirmLabel: 'Activer' }
      : { title: 'Désactiver le workflow', message: <>« {name} » sera désactivé dans n8n : plus aucun déclenchement jusqu’à sa réactivation.</>, confirmLabel: 'Désactiver', danger: true, input: { label: 'Motif (facultatif, conservé dans le journal)', placeholder: 'Ex. : maintenance chez le client' } });
    if (!r.ok) return;
    setBusy(true);
    try {
      await api.post(`/api/admin/workflows/${wf.id}/${on ? 'activate' : 'deactivate'}`, on ? {} : { reason: r.value?.trim() || undefined });
      toast(on ? 'Workflow activé.' : 'Workflow désactivé.');
      onChanged(on);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const label = wf.active ? 'Actif' : 'Inactif';
  return (
    <span className="ag-inline-state" title={lockedOn ? 'Workflow critique : désactivation bloquée' : undefined}>
      <Switch checked={wf.active} disabled={busy || lockedOn || !!wf.deleted_at} onChange={change} label={`${wf.active ? 'Désactiver' : 'Activer'} « ${name} »`} />
      {withLabel && <span className={`state ${wf.active ? 'on' : 'off'}`}>{label}</span>}
      {wf.is_locked && <span aria-label="Critique" title="Workflow critique : ne peut pas être désactivé">🔒</span>}
    </span>
  );
}

// ---------------------------------------------------------------- journal des actions sur les workflows

export interface ActionRow { id: number; created_at: string; actor_email: string | null; actor_role: string | null; action: string; result: string; message: string | null; workflow_id: string | null; workflow_name?: string | null; client_id?: string | null; client_name?: string | null }

export function ActionLogTable({ rows, showWorkflow = true, showClient = false }: { rows: ActionRow[]; showWorkflow?: boolean; showClient?: boolean }) {
  if (!rows.length) return <Empty>Aucune action enregistrée.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Date</th><th>Auteur</th>{showClient && <th>Client</th>}{showWorkflow && <th>Workflow</th>}<th>Action</th><th>Résultat</th><th>Message</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="nowrap">{fmtDateTime(a.created_at)}</td>
              <td>{a.actor_email ?? <span className="muted">Système</span>}<span className="ag-sub">{a.actor_role === 'client' ? 'Client' : a.actor_role === 'admin' ? 'Agence' : a.actor_role ?? ''}</span></td>
              {showClient && <td>{a.client_id ? <Link to={`/agence/clients/${a.client_id}`}>{a.client_name}</Link> : '—'}</td>}
              {showWorkflow && <td>{a.workflow_id ? <Link to={`/agence/workflows/${a.workflow_id}`}>{a.workflow_name ?? 'Workflow'}</Link> : '—'}</td>}
              <td>{ACTION_LABELS[a.action] ?? a.action}</td>
              <td><ActionResultBadge result={a.result} /></td>
              <td className="small">{a.message ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Catégories d'erreurs sous forme de liste compacte. */
export function CategoryCounts({ rows, total }: { rows: { category: string; n: number }[]; total?: number }) {
  if (!rows.length) return <Empty>Aucune erreur sur la période.</Empty>;
  const max = Math.max(...rows.map((r) => r.n));
  const sum = total ?? rows.reduce((s, r) => s + r.n, 0);
  return (
    <ul className="ag-cats">
      {[...rows].sort((a, b) => b.n - a.n).map((c) => (
        <li key={c.category}>
          <span><CategoryBadge category={c.category} /></span>
          <span className="bar" aria-hidden="true"><span style={{ width: `${Math.max(3, (c.n / max) * 100)}%` }} /></span>
          <span className="num">{fmtNum(c.n)} <span className="muted">· {fmtPct(sum ? c.n / sum : null)}</span></span>
        </li>
      ))}
    </ul>
  );
}
