import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum, TICKET_KIND, TICKET_STATUS } from '../../lib/format';
import { Async, Badge, Card, Empty, PageHead } from '../../components/ui';
import { Ago, ClientSelect, TicketStatusBadge, useClientList } from './shared';

export default function Tickets() {
  useTitle('Demandes');
  const [sp, setSp] = useSearchParams();
  const status = sp.get('statut') ?? 'open';
  const client = sp.get('client') ?? '';
  const set = (k: string, v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const { clients } = useClientList();
  const r = useApi<any[]>(`/api/admin/tickets${qs({ status: status === 'all' ? '' : status, client_id: client })}`);
  const nav = useNavigate();
  return (
    <div className="stack">
      <PageHead title="Demandes" sub="Demandes de modification, signalements et questions envoyés par les clients depuis leur portail." />
      <Card>
        <div className="filters">
          <select value={status} onChange={(e) => set('statut', e.target.value === 'open' ? '' : e.target.value)} aria-label="Statut">
            <option value="open">En cours (nouvelles, en traitement, en attente)</option>
            {Object.entries(TICKET_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            <option value="all">Toutes</option>
          </select>
          <ClientSelect value={client} onChange={(v) => set('client', v)} clients={clients} />
        </div>
        <Async {...r}>
          {(rows) => rows.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th className="num">N°</th><th>Objet</th><th>Type</th><th>Client</th><th>Workflow</th><th>Statut</th><th className="num">Messages</th><th>Mise à jour</th></tr></thead>
              <tbody>{rows.map((t) => (
                <tr key={t.id} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) nav(`/agence/demandes/${t.id}`); }}>
                  <td className="num muted">{t.id}</td>
                  <td><Link to={`/agence/demandes/${t.id}`} style={{ fontWeight: t.status === 'new' ? 700 : 500 }}>{t.subject}</Link><span className="ag-sub">Par {t.created_by_name ?? '—'} le {fmtDateTime(t.created_at)}</span></td>
                  <td>{t.kind === 'problem' ? <Badge tone="warn">{TICKET_KIND[t.kind]}</Badge> : <Badge>{TICKET_KIND[t.kind] ?? t.kind}</Badge>}</td>
                  <td><Link to={`/agence/clients/${t.client_id}`}>{t.client_name}</Link></td>
                  <td>{t.workflow_id ? <Link to={`/agence/workflows/${t.workflow_id}`}>{t.workflow_name}</Link> : <span className="muted">—</span>}</td>
                  <td><TicketStatusBadge status={t.status} /></td>
                  <td className="num">{fmtNum(t.messages)}</td>
                  <td><Ago at={t.updated_at} /></td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>{status === 'open' ? 'Aucune demande en cours.' : 'Aucune demande pour ces critères.'}</Empty>}
        </Async>
      </Card>
    </div>
  );
}
