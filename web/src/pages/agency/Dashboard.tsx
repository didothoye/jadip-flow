import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum, fmtPct, fmtUsd, fromNow } from '../../lib/format';
import { Async, Card, Empty, HealthBadge, PageHead } from '../../components/ui';
import { DailyBars } from '../../components/charts';
import { Ago, CategoryBadge, CategoryCounts, rateTone, type ErrorRow } from './shared';

interface Overview {
  overview: {
    instances: number; instances_unhealthy: number; clients: number; workflows_active: number; workflows_inactive: number; workflows_unassigned: number;
    exec_today: number; fail_today: number; exec_week: number; ok_week: number; fail_week: number; alerts_open: number; llm_month_usd: number; success_rate_week: number | null;
  };
  series: { day: string; total: number; success: number; failed: number }[];
  errors: ErrorRow[];
  categories: { category: string; n: number }[];
  clients: { id: string; name: string; at_risk: boolean; risks: string[]; archived_at: string | null; llm_month_usd: number; monthly_budget_usd: number | null; last_execution_at: string | null }[];
  instances: { id: string; name: string; health_status: string; health_message: string | null; last_sync_at: string | null; last_sync_status: string | null }[];
}

function Kpi({ to, label, value, hint, tone }: { to: string; label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : undefined;
  return (
    <Link to={to} className="card stat">
      <span className="label">{label}</span>
      <span className="value" style={{ color }}>{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </Link>
  );
}

export default function Dashboard() {
  useTitle('Tableau de bord');
  const r = useApi<Overview>('/api/admin/overview');
  return (
    <div className="stack">
      <PageHead title="Tableau de bord" sub="État de la flotte n8n et des clients en un coup d’œil."
        actions={<button className="btn" onClick={r.reload} disabled={r.loading}>{r.loading ? 'Actualisation…' : 'Actualiser'}</button>} />
      <Async {...r}>
        {(d) => {
          const o = d.overview;
          const atRisk = d.clients.filter((c) => c.at_risk && !c.archived_at);
          const unhealthy = d.instances.filter((i) => i.health_status !== 'ok');
          const allGood = !unhealthy.length && !atRisk.length && !d.errors.length && !o.alerts_open;
          return (
            <>
              {allGood ? (
                <div className="alert success">Tout est opérationnel : aucune instance en difficulté, aucun client à risque, aucune erreur non traitée.</div>
              ) : (
                <div className="alert warn">
                  À surveiller :{' '}
                  {[
                    unhealthy.length ? `${unhealthy.length} instance(s) en difficulté` : null,
                    atRisk.length ? `${atRisk.length} client(s) à risque` : null,
                    d.errors.length ? `${d.errors.length >= 10 ? '10+' : d.errors.length} erreur(s) non traitée(s)` : null,
                    o.alerts_open ? `${o.alerts_open} alerte(s) ouverte(s)` : null,
                  ].filter(Boolean).join(' · ')}.
                </div>
              )}

              <div className="ag-kpis">
                <Kpi to="/agence/executions" label="Exécutions aujourd’hui" value={fmtNum(o.exec_today)}
                  hint={o.fail_today ? <span style={{ color: 'var(--bad)' }}>{fmtNum(o.fail_today)} en échec</span> : 'Aucun échec'} />
                <Kpi to="/agence/executions" label="Taux de réussite (7 j)" value={fmtPct(o.success_rate_week, 1)} tone={rateTone(o.success_rate_week)}
                  hint={`${fmtNum(o.exec_week)} exécutions · ${fmtNum(o.fail_week)} échecs`} />
                <Kpi to="/agence/alertes" label="Alertes ouvertes" value={fmtNum(o.alerts_open)} tone={o.alerts_open ? 'bad' : 'good'} hint="À prendre en compte" />
                <Kpi to="/agence/instances" label="Instances n8n" value={fmtNum(o.instances)} tone={o.instances_unhealthy ? 'bad' : undefined}
                  hint={o.instances_unhealthy ? `${o.instances_unhealthy} en difficulté` : 'Toutes opérationnelles'} />
                <Kpi to="/agence/clients" label="Clients" value={fmtNum(o.clients)} hint={atRisk.length ? <span style={{ color: 'var(--bad)' }}>{atRisk.length} à risque</span> : 'Aucun à risque'} />
                <Kpi to="/agence/workflows" label="Workflows actifs" value={fmtNum(o.workflows_active)} hint={`${fmtNum(o.workflows_inactive)} inactif(s)`} />
                <Kpi to="/agence/workflows?non_rattaches=1" label="Non rattachés" value={fmtNum(o.workflows_unassigned)} tone={o.workflows_unassigned ? 'warn' : undefined} hint="Sans client associé" />
                <Kpi to="/agence/couts" label="Coût IA du mois" value={fmtUsd(o.llm_month_usd)} hint="Tous clients confondus" />
              </div>

              <div className="ag-2-1">
                <Card title="Exécutions des 14 derniers jours" actions={<Link to="/agence/executions" className="small">Toutes les exécutions</Link>}>
                  <DailyBars data={d.series} />
                </Card>
                <Card title="Instances n8n" actions={<Link to="/agence/instances" className="small">Gérer</Link>}>
                  {d.instances.length ? (
                    <ul className="ag-list">
                      {d.instances.map((i) => (
                        <li key={i.id}>
                          <span className="main-col">
                            <span className="title">{i.name}</span>
                            <span className="meta" style={{ display: 'block' }} title={i.last_sync_at ? fmtDateTime(i.last_sync_at) : undefined}>
                              Synchronisée {fromNow(i.last_sync_at)}{i.last_sync_status === 'error' ? ' · dernière synchro en échec' : ''}
                            </span>
                            {i.health_status !== 'ok' && i.health_message && <span className="meta" style={{ display: 'block', color: 'var(--bad)' }}>{i.health_message}</span>}
                          </span>
                          <HealthBadge status={i.health_status} />
                        </li>
                      ))}
                    </ul>
                  ) : <Empty>Aucune instance. <Link to="/agence/instances">Ajouter une instance</Link></Empty>}
                </Card>
              </div>

              <div className="ag-2-1">
                <Card title="Erreurs récentes non traitées" actions={<Link to="/agence/erreurs?non_traitees=1" className="small">Toutes les erreurs</Link>}>
                  {d.errors.length ? (
                    <ul className="ag-list">
                      {d.errors.map((e) => (
                        <li key={e.id}>
                          <span className="main-col">
                            <Link to={`/agence/workflows/${e.workflow_id}`} className="title">{e.workflow_display_name}</Link>
                            <span className="meta" style={{ display: 'block' }}>{e.client_name ?? 'Non rattaché'} · <Ago at={e.started_at} />{e.error_node ? ` · nœud « ${e.error_node} »` : ''}</span>
                            <span className="small ag-clamp" style={{ maxWidth: '100%' }}>{e.error_message ?? 'Détail en cours de récupération'}</span>
                          </span>
                          <CategoryBadge category={e.error_category} />
                        </li>
                      ))}
                    </ul>
                  ) : <Empty>Aucune erreur en attente de traitement.</Empty>}
                </Card>
                <div className="stack">
                  <Card title="Clients à risque" actions={<Link to="/agence/clients" className="small">Tous les clients</Link>}>
                    {atRisk.length ? (
                      <ul className="ag-list">
                        {atRisk.map((c) => (
                          <li key={c.id}>
                            <span className="main-col">
                              <Link to={`/agence/clients/${c.id}`} className="title">{c.name}</Link>
                              {c.risks.map((x) => <span key={x} className="meta" style={{ display: 'block', color: 'var(--bad)' }}>{x}</span>)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : <Empty>Aucun client à risque.</Empty>}
                  </Card>
                  <Card title="Erreurs par catégorie (7 j)">
                    <CategoryCounts rows={d.categories} />
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}
