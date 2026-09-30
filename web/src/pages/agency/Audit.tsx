import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { Async, Badge, Card, Empty, ErrorBox, Loading, PageHead } from '../../components/ui';
import { ActionLogTable, ClientSelect, JsonDetail, SOURCE_LABELS, Tabs, useClientList, useTab, type ActionRow } from './shared';

interface AuditRow { id: number; at: string; actor_label: string | null; source: string; action: string; target_type: string | null; target_id: string | null; client_id: string | null; ip: string | null; detail: unknown }

const TARGET_LABELS: Record<string, string> = {
  workflow: 'Workflow', client: 'Client', user: 'Utilisateur', instance: 'Instance', alert: 'Alerte', alert_rule: 'Règle d’alerte', execution: 'Exécution',
  ticket: 'Demande', report: 'Rapport', webhook: 'Webhook', api_token: 'Jeton d’API', llm_account: 'Compte IA', llm_rule: 'Règle d’attribution', llm_usage: 'Coût IA',
};
const PAGE = 100;
const TABS = ['audit', 'actions'] as const;
type Tab = (typeof TABS)[number];

export default function Audit() {
  useTitle('Journal d’audit');
  const [tab, setTab] = useTab<Tab>(TABS, 'audit');
  const { all, clients } = useClientList();
  return (
    <div className="stack">
      <PageHead title="Journal d’audit" sub="Toutes les actions sensibles, chaînées par empreinte : toute modification a posteriori est détectable." actions={<Verify />} />
      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[['audit', 'Journal d’audit'], ['actions', 'Actions sur les workflows']]} />
        {tab === 'audit' ? <AuditLog clientsAll={all} clients={clients} /> : <Actions clients={clients} />}
      </div>
    </div>
  );
}

function Verify() {
  const [state, setState] = useState<{ ok: boolean; checked: number; brokenAt: number | null } | 'busy' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setState('busy'); setErr(null);
    try { setState(await api.get('/api/admin/audit/verify')); } catch (e: any) { setErr(e.message); setState(null); }
  };
  return (
    <div className="row">
      {state && state !== 'busy' && (state.ok
        ? <Badge tone="good">Intégrité vérifiée : {fmtNum(state.checked)} entrées</Badge>
        : <Badge tone="bad">Chaîne rompue à l’entrée n° {state.brokenAt}</Badge>)}
      {err && <Badge tone="bad">{err}</Badge>}
      <button className="btn" onClick={run} disabled={state === 'busy'}>{state === 'busy' ? 'Vérification…' : 'Vérifier l’intégrité'}</button>
    </div>
  );
}

function Target({ r }: { r: AuditRow }) {
  if (!r.target_type) return <span className="muted">—</span>;
  const label = TARGET_LABELS[r.target_type] ?? r.target_type;
  const id = r.target_id ?? '';
  const to = r.target_type === 'workflow' ? `/agence/workflows/${id}` : r.target_type === 'client' ? `/agence/clients/${id}` : r.target_type === 'ticket' ? `/agence/demandes/${id}` : null;
  const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return <>{label}{id && <> {to ? <Link to={to} className="mono small">{short}</Link> : <span className="mono small" title={id}>{short}</span>}</>}</>;
}

function AuditLog({ clientsAll, clients }: { clientsAll: { id: string; name: string }[]; clients: any[] }) {
  const [action, setAction] = useState('');
  const [debounced, setDebounced] = useState('');
  const [source, setSource] = useState('');
  const [client, setClient] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const names = useMemo(() => Object.fromEntries(clientsAll.map((c) => [c.id, c.name])), [clientsAll]);
  useEffect(() => { const t = setTimeout(() => setDebounced(action.trim()), 300); return () => clearTimeout(t); }, [action]);
  const base = `/api/admin/audit${qs({ action: debounced, source, client_id: client, limit: PAGE })}`;
  const load = async (before?: number) => {
    setLoading(true);
    try {
      const r = await api.get<AuditRow[]>(before ? `${base}&before=${before}` : base);
      setRows((p) => (before ? [...p, ...r] : r));
      setMore(r.length === PAGE);
      setError(null);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card>
      <div className="filters">
        <input type="search" value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action (ex. : workflow., auth.login)" aria-label="Filtrer par action" />
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">Toutes les sources</option>
          {Object.entries(SOURCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <ClientSelect value={client} onChange={setClient} clients={clients} />
      </div>
      <ErrorBox error={error} />
      {loading && !rows.length ? <Loading /> : rows.length ? (
        <>
          <div className="table-wrap"><table className="table">
            <thead><tr><th className="num">N°</th><th>Date</th><th>Acteur</th><th>Source</th><th>Action</th><th>Cible</th><th>Client</th><th>IP</th><th>Détail</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="num muted small">{r.id}</td>
                <td className="nowrap small">{fmtDateTime(r.at)}</td>
                <td className="small">{r.actor_label ?? <span className="muted">Système</span>}</td>
                <td><Badge tone={r.source === 'system' ? undefined : r.source === 'web' ? 'info' : 'warn'}>{SOURCE_LABELS[r.source] ?? r.source}</Badge></td>
                <td className="mono small">{r.action}</td>
                <td className="small nowrap"><Target r={r} /></td>
                <td className="small">{r.client_id ? <Link to={`/agence/clients/${r.client_id}`}>{names[r.client_id] ?? 'Client'}</Link> : <span className="muted">—</span>}</td>
                <td className="mono small">{r.ip ?? '—'}</td>
                <td><JsonDetail value={r.detail} /></td>
              </tr>))}</tbody>
          </table></div>
          <div className="ag-more">{more ? <button className="btn" disabled={loading} onClick={() => load(rows[rows.length - 1].id)}>{loading ? 'Chargement…' : 'Charger plus'}</button>
            : <span className="muted small">{fmtNum(rows.length)} entrée(s) · fin du journal</span>}</div>
        </>
      ) : <Empty>Aucune entrée pour ces critères.</Empty>}
    </Card>
  );
}

function Actions({ clients }: { clients: any[] }) {
  const [client, setClient] = useState('');
  const r = useApi<ActionRow[]>(`/api/admin/actions${qs({ client_id: client, limit: 300 })}`);
  return (
    <Card title="Activations, désactivations et relances" actions={<ClientSelect value={client} onChange={setClient} clients={clients} />}>
      <p className="muted small" style={{ marginTop: 0 }}>Y compris les actions refusées (droits insuffisants, workflow critique) et les erreurs renvoyées par n8n. 300 dernières actions.</p>
      <Async {...r}>{(rows) => <ActionLogTable rows={rows} showClient />}</Async>
    </Card>
  );
}
