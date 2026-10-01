import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtNum, fmtPct, fmtUsd, fromNow } from '../../lib/format';
import { Async, Card, Empty, HealthBadge } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';
import { DailyBars } from '../../components/charts';
import { Ago, CategoryBadge, CategoryCounts, type ErrorRow } from './shared';

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

const toneColor = (tone?: 'good' | 'bad' | 'warn') => (tone ? `var(--${tone})` : undefined);

function Kpi({ to, icon, label, value, hint, tone }: { to: string; icon: IconName; label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <Link to={to} className="card stat">
      <span className="label"><span style={{ color: toneColor(tone) ?? 'var(--brand)', display: 'inline-flex' }}><Icon name={icon} size={17} stroke={2} /></span>{label}</span>
      <span className="value" style={{ color: toneColor(tone) }}>{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </Link>
  );
}

export default function Dashboard() {
  useTitle('Tableau de bord');
  const { user } = useAuth();
  const r = useApi<Overview>('/api/admin/overview');
  const { reload } = r;
  useEffect(() => {
    window.addEventListener('jf:synced', reload);
    return () => window.removeEventListener('jf:synced', reload);
  }, [reload]);
  return (
    <div className="stack">
      <div className="greet">
        <div>
          <div className="hello">Bonjour,</div>
          <h1>{user?.name ?? 'Agence'}</h1>
          {r.data && (
            <div className="ctx">
              AGENCE · {fmtNum(r.data.overview.clients)} client{r.data.overview.clients > 1 ? 's' : ''} · {fmtNum(r.data.overview.instances)} instance{r.data.overview.instances > 1 ? 's' : ''} n8n
            </div>
          )}
        </div>
        <div className="tools">
          <button className="icon-btn" onClick={reload} disabled={r.loading} aria-label="Actualiser" title="Actualiser"><Icon name="sync" /></button>
        </div>
      </div>
      <Async {...r}>
        {(d) => {
          const o = d.overview;
          const atRisk = d.clients.filter((c) => c.at_risk && !c.archived_at);
          const unhealthy = d.instances.filter((i) => i.health_status !== 'ok');
          const watch = [
            unhealthy.length ? `${unhealthy.length} instance(s) en difficulté` : null,
            atRisk.length ? `${atRisk.length} client(s) à risque` : null,
            d.errors.length ? `${d.errors.length >= 10 ? '10+' : d.errors.length} erreur(s) non traitée(s)` : null,
          ].filter(Boolean);
          return (
            <>
              <div className="ag-kpis cols-3">
                <Kpi to="/agence/executions" icon="bolt" label="Exécutions aujourd’hui" value={fmtNum(o.exec_today)}
                  hint={o.fail_today ? <span style={{ color: 'var(--bad)' }}>{fmtNum(o.fail_today)} en échec</span> : 'Aucun échec'} />
                <Kpi to="/agence/alertes" icon="alert" label="Alertes ouvertes" value={fmtNum(o.alerts_open)} tone={o.alerts_open ? 'bad' : 'good'}
                  hint={o.alerts_open ? 'À prendre en compte' : 'Rien à signaler'} />
                <Kpi to="/agence/workflows?non_rattaches=1" icon="flow" label="Non rattachés" value={fmtNum(o.workflows_unassigned)} tone={o.workflows_unassigned ? 'warn' : undefined}
                  hint="Workflows sans client associé" />
              </div>
              <p className="note-line">
                {watch.length
                  ? <>À surveiller : <strong>{watch.join(' · ')}</strong>.</>
                  : <>Tout est opérationnel : aucune instance en difficulté, aucun client à risque, aucune erreur non traitée.</>}
              </p>

              <section className="hero" aria-label="Santé de la flotte n8n">
                <div className="top">
                  <span className="row" style={{ gap: '.5rem' }}>Santé de la flotte n8n <Icon name="pulse" /></span>
                  <Link to="/agence/executions">Détail <Icon name="chevron" size={18} /></Link>
                </div>
                <div className="big">{fmtPct(o.success_rate_week, 1)}</div>
                <div className="facts">
                  <span>de réussite sur 7 jours · <strong>{fmtNum(o.exec_week)}</strong> exécutions, <strong>{fmtNum(o.fail_week)}</strong> échecs</span>
                </div>
                <div className="facts">
                  <span>Clients : <strong>{fmtNum(o.clients)}</strong>{atRisk.length ? ` (${atRisk.length} à risque)` : ''}</span>
                  <span>Workflows actifs : <strong>{fmtNum(o.workflows_active)}</strong>{o.workflows_inactive ? ` (${fmtNum(o.workflows_inactive)} inactifs)` : ''}</span>
                  <span>Instances : <strong>{o.instances_unhealthy ? `${o.instances_unhealthy} en difficulté` : 'opérationnelles'}</strong></span>
                  <span>Coût IA du mois : <strong>{fmtUsd(o.llm_month_usd)}</strong></span>
                </div>
              </section>

              <div className="ag-2-1">
                <Card title={<>Exécutions <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>sur 14 jours</span></>}
                  actions={<Link to="/agence/executions">Toutes <Icon name="chevron" size={15} stroke={2.2} /></Link>}>
                  <DailyBars data={d.series} />
                </Card>
                <Card title="Instances n8n" actions={<Link to="/agence/instances">Gérer</Link>}>
                  {d.instances.length ? (
                    <ul className="ag-list">
                      {d.instances.map((i) => (
                        <li key={i.id}>
                          <span className={`ag-tile ${i.health_status === 'ok' ? 'good' : 'bad'}`}><Icon name="server" size={18} /></span>
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
                <Card title="À traiter" actions={<Link to="/agence/erreurs?non_traitees=1">Toutes les erreurs <Icon name="chevron" size={15} stroke={2.2} /></Link>}>
                  {d.errors.length ? (
                    <ul className="ag-list">
                      {d.errors.map((e) => (
                        <li key={e.id}>
                          <span className="ag-tile bad"><Icon name="alert" size={18} stroke={2} /></span>
                          <span className="main-col">
                            <Link to={`/agence/workflows/${e.workflow_id}`} className="title">{e.workflow_display_name}</Link>
                            <span className="meta" style={{ display: 'block' }}>{e.client_name ?? 'Non rattaché'} · <Ago at={e.started_at} />{e.error_node ? ` · nœud « ${e.error_node} »` : ''}</span>
                            <span className="small ag-clamp mono" style={{ maxWidth: '100%', color: 'var(--muted)' }}>{e.error_message ?? 'Détail en cours de récupération'}</span>
                          </span>
                          <CategoryBadge category={e.error_category} />
                        </li>
                      ))}
                    </ul>
                  ) : <Empty>Aucune erreur en attente de traitement.</Empty>}
                </Card>
                <div className="stack">
                  <Card title="Clients à risque" actions={<Link to="/agence/clients">Tous</Link>}>
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
                  <Card title={<>Erreurs par catégorie <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>· 7 j</span></>}>
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
