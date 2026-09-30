import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtNum } from '../../lib/format';
import { Async, Badge, Card, Empty, PageHead, StatusBadge } from '../../components/ui';
import { Ago, ClientSelect, Rate, useClientList, WorkflowSwitch } from './shared';

export default function Workflows() {
  useTitle('Workflows');
  const [sp, setSp] = useSearchParams();
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);
  const clientId = sp.get('client') ?? '';
  const instanceId = sp.get('instance') ?? '';
  const unassigned = sp.get('non_rattaches') === '1';
  const deleted = sp.get('supprimes') === '1';
  const setParam = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  useEffect(() => { const t = setTimeout(() => { setDebounced(search.trim()); setParam('q', search.trim()); }, 300); return () => clearTimeout(t); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const { clients } = useClientList();
  const instances = useApi<{ id: string; name: string }[]>('/api/admin/instances');
  const r = useApi<any[]>(`/api/admin/workflows${qs({ search: debounced, client_id: clientId, instance_id: instanceId, unassigned: unassigned || undefined, include_deleted: deleted || undefined })}`);
  const patchRow = (id: string, active: boolean) => r.setData((rows) => rows?.map((w) => (w.id === id ? { ...w, active } : w)) ?? rows);
  return (
    <div className="stack">
      <PageHead title="Workflows" sub="Tous les workflows synchronisés depuis vos instances n8n." />
      <Card>
        <div className="filters ag-filters">
          <input type="search" placeholder="Rechercher un workflow…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher" style={{ minWidth: 220 }} />
          <ClientSelect value={clientId} onChange={(v) => setParam('client', v)} clients={clients} />
          {(instances.data?.length ?? 0) > 1 && (
            <select value={instanceId} onChange={(e) => setParam('instance', e.target.value)} aria-label="Instance">
              <option value="">Toutes les instances</option>
              {instances.data!.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}
          <label className="check"><input type="checkbox" checked={unassigned} onChange={(e) => setParam('non_rattaches', e.target.checked ? '1' : '')} />Non rattachés uniquement</label>
          <label className="check"><input type="checkbox" checked={deleted} onChange={(e) => setParam('supprimes', e.target.checked ? '1' : '')} />Inclure les supprimés</label>
        </div>
        <Async {...r}>
          {(rows) => rows.length ? (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>{rows.length} workflow(s) · {rows.filter((w) => w.active).length} actif(s)</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Workflow</th><th>Client</th><th>Instance</th><th>État</th><th className="num">Exéc. 30 j</th><th className="num">Réussite</th><th>Dernière exécution</th><th className="num">Erreurs non traitées (7 j)</th><th>Étiquettes</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.id} className={w.deleted_at ? 'muted-row' : ''}>
                        <td>
                          <Link to={`/agence/workflows/${w.id}`} style={{ fontWeight: 600 }}>{w.name}</Link>
                          {w.display_name && <span className="ag-sub">Portail : {w.display_name}</span>}
                          {w.deleted_at && <Badge tone="warn">Supprimé dans n8n</Badge>}
                        </td>
                        <td>{w.client_id ? <Link to={`/agence/clients/${w.client_id}`}>{w.client_name}</Link> : <Badge tone="warn">Non rattaché</Badge>}
                          {w.client_id && <span className="ag-sub">{w.client_assignment === 'tag' ? 'Par étiquette' : 'Manuel'}</span>}</td>
                        <td className="small">{w.instance_name}</td>
                        <td><WorkflowSwitch wf={w} onChanged={(a) => patchRow(w.id, a)} withLabel /></td>
                        <td className="num">{fmtNum(w.exec_30d)}</td>
                        <td className="num"><Rate value={w.success_rate_30d} /></td>
                        <td><Ago at={w.last_execution_at} />{w.last_status && <span style={{ display: 'block', marginTop: '.2rem' }}><StatusBadge status={w.last_status} /></span>}</td>
                        <td className="num">{w.unhandled_errors_7d ? <Link to={`/agence/workflows/${w.id}?onglet=erreurs`}><Badge tone="bad">{w.unhandled_errors_7d}</Badge></Link> : <span className="muted">0</span>}</td>
                        <td><span className="ag-tags">{(w.tags ?? []).map((t: string) => <Badge key={t}>{t}</Badge>)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <Empty>{debounced || clientId || unassigned ? 'Aucun workflow ne correspond à ces critères.' : 'Aucun workflow synchronisé. Ajoutez une instance n8n pour commencer.'}</Empty>}
        </Async>
      </Card>
    </div>
  );
}
