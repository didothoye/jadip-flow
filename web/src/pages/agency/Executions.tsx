import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { CATEGORY_LABELS } from '../../lib/format';
import { Card, PageHead } from '../../components/ui';
import { ClientSelect, ExecutionTable, useClientList, useCursorList, type ExecRow } from './shared';

/** Bornes de dates saisies (jour local de l'application, UTC+1) → instants ISO. */
const dayStart = (d: string) => (d ? `${d}T00:00:00+01:00` : undefined);
const dayEnd = (d: string) => {
  if (!d) return undefined;
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return `${x.toISOString().slice(0, 10)}T00:00:00+01:00`;
};

export default function Executions() {
  useTitle('Exécutions');
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (patch: Record<string, string>) => setSp((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k);
    return n;
  }, { replace: true });
  const client = get('client'), workflow = get('workflow'), status = get('statut'), category = get('categorie'), from = get('du'), to = get('au');
  const { clients, all } = useClientList();
  const wfs = useApi<{ id: string; name: string; display_name: string | null; client_name: string | null }[]>(`/api/admin/workflows${qs({ client_id: client })}`);
  const names = useMemo(() => Object.fromEntries(all.map((c) => [c.id, c.name])), [all]);
  const list = useCursorList<ExecRow>(`/api/admin/executions${qs({
    client_id: client, workflow_id: workflow, status, category, from: dayStart(from), to: dayEnd(to), limit: 50,
  })}`);
  const active = client || workflow || status || category || from || to;
  return (
    <div className="stack">
      <PageHead title="Exécutions" sub="Historique des exécutions synchronisées, du plus récent au plus ancien (50 par page)." />
      <Card>
        <div className="filters ag-filters">
          <ClientSelect value={client} onChange={(v) => set({ client: v, workflow: '' })} clients={clients} />
          <select value={workflow} onChange={(e) => set({ workflow: e.target.value })} aria-label="Workflow" style={{ maxWidth: 280 }}>
            <option value="">Tous les workflows</option>
            {(wfs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.display_name || w.name}</option>)}
          </select>
          <select value={status} onChange={(e) => set({ statut: e.target.value })} aria-label="Statut">
            <option value="">Tous les statuts</option>
            <option value="success">Réussies</option>
            <option value="failed">Échecs</option>
            <option value="running">En cours</option>
            <option value="waiting">En attente</option>
            <option value="canceled">Annulées</option>
          </select>
          <select value={category} onChange={(e) => set({ categorie: e.target.value })} aria-label="Catégorie d’erreur">
            <option value="">Toutes les catégories</option>
            {Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <label className="field">Du<input type="date" value={from} max={to || undefined} onChange={(e) => set({ du: e.target.value })} /></label>
          <label className="field">Au<input type="date" value={to} min={from || undefined} onChange={(e) => set({ au: e.target.value })} /></label>
          {active && <button className="btn ghost small" onClick={() => setSp(new URLSearchParams(), { replace: true })}>Réinitialiser les filtres</button>}
        </div>
        <ExecutionTable list={list} clientNames={names} />
      </Card>
    </div>
  );
}
