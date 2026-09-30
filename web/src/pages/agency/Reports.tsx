import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { currentPeriod, fmtDateTime, fmtDuration, fmtNum, fmtPct, fmtUsd, periodLabel } from '../../lib/format';
import { Async, Badge, Card, Empty, PageHead, Stat, useAction, useUi } from '../../components/ui';
import { ClientSelect, Rate, Tabs, useClientList, useTab } from './shared';

const TABS = ['rapports', 'rentabilite'] as const;
type Tab = (typeof TABS)[number];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Reports() {
  useTitle('Rapports et rentabilité');
  const [tab, setTab] = useTab<Tab>(TABS, 'rapports');
  return (
    <div className="stack">
      <PageHead title="Rapports et rentabilité" sub="Rapports mensuels des clients (PDF et Excel) et marge par client." />
      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[['rapports', 'Rapports mensuels'], ['rentabilite', 'Rentabilité']]} />
        {tab === 'rapports' ? <ReportList /> : <Profitability />}
      </div>
    </div>
  );
}

function prevPeriod() {
  const d = new Date();
  d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ReportList() {
  const { clients } = useClientList();
  const [filter, setFilter] = useState('');
  const r = useApi<any[]>(`/api/admin/reports${qs({ client_id: filter })}`);
  const { run, busy } = useAction();
  const { confirm, toast } = useUi();
  const [f, setF] = useState({ client_id: '', period: prevPeriod(), send: false });
  const generate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => api.post<{ sent: number }>('/api/admin/reports', f));
    if (res) {
      toast(f.send ? `Rapport généré et envoyé à ${res.sent} destinataire(s).` : 'Rapport généré.');
      r.reload();
    }
  };
  const send = async (x: any) => {
    const c = await confirm({ title: 'Envoyer le rapport', confirmLabel: 'Envoyer', message: <>Le rapport de {periodLabel(x.period)} sera envoyé par e-mail aux destinataires configurés pour {x.client_name}.</> });
    if (!c.ok) return;
    const res = await run(() => api.post<{ sent: number }>(`/api/admin/reports/${x.id}/send`));
    if (res) { toast(`Rapport envoyé à ${res.sent} destinataire(s).`); r.reload(); }
  };
  return (
    <div className="stack">
      <Card title="Générer un rapport">
        <form className="form" onSubmit={generate}>
          <div className="form-grid">
            <label className="field">Client<ClientSelect value={f.client_id} onChange={(v) => setF({ ...f, client_id: v })} clients={clients} allLabel="Choisir un client" /></label>
            <label className="field">Mois<input type="month" required value={f.period} max={currentPeriod()} onChange={(e) => setF({ ...f, period: e.target.value })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /><span>L’envoyer aussitôt par e-mail aux destinataires du client</span></label>
          <p className="muted small" style={{ margin: 0 }}>Un rapport existant pour le même mois est remplacé. Les rapports du mois écoulé sont aussi générés automatiquement (voir Paramètres).</p>
          <div className="ag-form-foot"><button className="btn primary" disabled={busy || !f.client_id || !/^\d{4}-\d{2}$/.test(f.period)}>{busy ? 'Génération…' : 'Générer'}</button></div>
        </form>
      </Card>
      <Card title="Rapports générés" actions={<ClientSelect value={filter} onChange={setFilter} clients={clients} />}>
        <Async {...r}>
          {(rows) => rows.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Mois</th><th>Client</th><th className="num">Exécutions</th><th className="num">Réussite</th><th className="num">Temps gagné</th><th className="num">Coût IA</th><th>Envoi</th><th className="right">Fichiers</th></tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={x.id}>
                  <td className="nowrap"><strong>{cap(periodLabel(x.period))}</strong><span className="ag-sub">Généré le {fmtDateTime(x.created_at)}</span></td>
                  <td><Link to={`/agence/clients/${x.client_id}`}>{x.client_name}</Link></td>
                  <td className="num">{fmtNum(x.totals?.executions)}</td>
                  <td className="num"><Rate value={x.totals?.successRate} /></td>
                  <td className="num">{fmtDuration(x.totals?.minutesSaved)}</td>
                  <td className="num">{fmtUsd(x.totals?.costUsd)}</td>
                  <td>{x.emailed_at ? <Badge tone="good" title={fmtDateTime(x.emailed_at)}>Envoyé</Badge> : <span className="muted small">Non envoyé</span>}</td>
                  <td className="actions">
                    <a className="btn small" href={`/api/admin/reports/${x.id}/pdf`} download>PDF</a>{' '}
                    <a className="btn small" href={`/api/admin/reports/${x.id}/xlsx`} download>Excel</a>{' '}
                    <button className="btn small" disabled={busy} onClick={() => send(x)}>{x.emailed_at ? 'Renvoyer' : 'Envoyer'}</button>
                  </td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>Aucun rapport généré.</Empty>}
        </Async>
      </Card>
    </div>
  );
}

interface ProfRow { id: string; name: string; is_internal: boolean; fee: number | null; llm_cost: number; workflows_active: number; margin: number | null; margin_rate: number | null }

function Profitability() {
  const [period, setPeriod] = useState(currentPeriod());
  const r = useApi<{ period: string; rows: ProfRow[] }>(/^\d{4}-\d{2}$/.test(period) ? `/api/admin/profitability${qs({ period })}` : null);
  const tone = (m: number | null) => (m == null ? undefined : m < 0 ? 'var(--bad)' : m < 0.5 ? 'var(--warn)' : 'var(--good)');
  return (
    <div className="stack">
      <Card>
        <div className="filters ag-filters" style={{ marginBottom: 0 }}>
          <label className="field">Mois<input type="month" value={period} max={currentPeriod()} onChange={(e) => setPeriod(e.target.value)} /></label>
          <p className="muted small" style={{ margin: 0 }}>Marge = facturation mensuelle − coût IA du mois. La facturation se règle dans les paramètres de chaque client.</p>
        </div>
      </Card>
      <Async {...r}>
        {(d) => {
          const billed = d.rows.filter((x) => x.fee != null);
          const fee = billed.reduce((s, x) => s + (x.fee ?? 0), 0);
          const cost = d.rows.reduce((s, x) => s + x.llm_cost, 0);
          const billedCost = billed.reduce((s, x) => s + x.llm_cost, 0);
          const margin = fee - billedCost;
          return (
            <>
              <div className="grid cols-4">
                <Stat label="Facturation" value={fmtUsd(fee)} hint={cap(periodLabel(d.period))} />
                <Stat label="Coût IA" value={fmtUsd(cost)} hint="Tous clients, internes compris" />
                <Stat label="Marge (clients facturés)" value={fmtUsd(margin)} tone={margin < 0 ? 'bad' : 'good'} />
                <Stat label="Taux de marge" value={fmtPct(fee ? margin / fee : null, 1)} />
              </div>
              <Card title="Par client">
                {d.rows.length ? (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th>Client</th><th className="num">Workflows actifs</th><th className="num">Facturation mensuelle</th><th className="num">Coût IA</th><th className="num">Marge</th><th className="num">Taux de marge</th></tr></thead>
                    <tbody>{d.rows.map((x) => (
                      <tr key={x.id}>
                        <td><Link to={`/agence/clients/${x.id}?onglet=parametres`}>{x.name}</Link>{x.is_internal && <> <Badge>Interne</Badge></>}</td>
                        <td className="num">{fmtNum(x.workflows_active)}</td>
                        <td className="num">{x.fee == null ? <span className="muted">Non renseignée</span> : fmtUsd(x.fee)}</td>
                        <td className="num">{fmtUsd(x.llm_cost)}</td>
                        <td className="num" style={{ color: x.margin != null && x.margin < 0 ? 'var(--bad)' : undefined }}>{fmtUsd(x.margin)}</td>
                        <td className="num" style={{ color: tone(x.margin_rate), fontWeight: 600 }}>{fmtPct(x.margin_rate, 1)}</td>
                      </tr>))}</tbody>
                    <tfoot><tr><td>Total</td><td className="num">{fmtNum(d.rows.reduce((s, x) => s + x.workflows_active, 0))}</td><td className="num">{fmtUsd(fee)}</td><td className="num">{fmtUsd(cost)}</td><td className="num">{fmtUsd(margin)}</td><td className="num">{fmtPct(fee ? margin / fee : null, 1)}</td></tr></tfoot>
                  </table></div>
                ) : <Empty>Aucun client actif.</Empty>}
              </Card>
            </>
          );
        }}
      </Async>
    </div>
  );
}
