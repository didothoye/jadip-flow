import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { fmtDuration, fmtNum, fmtPct } from '../../lib/format';
import { Async, Empty, PageHead, Stat } from '../../components/ui';
import { rateTone, shortAgo, useWorkflowControls, WfState, WfToggle, type WfCard } from './shared';

interface HomeData {
  client: { id: string; name: string; show_costs: boolean; show_reports: boolean };
  summary: { active: number; total: number; minutes_saved_month: number; success_rate_30d: number | null; executions_30d: number; incidents_7d: number };
  workflows: WfCard[];
}

export default function Home() {
  useTitle('Vos automatisations');
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<HomeData>('/api/portal/home');
  const ctl = useWorkflowControls(reload);
  const first = user?.name?.split(' ')[0];
  return (
    <div className="stack">
      <PageHead crumb={first ? <span className="p-hello">Bonjour {first} 👋</span> : undefined} title="Vos automatisations" />
      <Async data={data} error={error} loading={loading}>
        {(d) => (
          <>
            <Banner d={d} />
            {d.summary.total > 0 && (
              <div className="grid cols-3 p-stats">
                <Stat label="Automatisations actives" value={`${d.summary.active} / ${d.summary.total}`}
                  hint={d.summary.active === d.summary.total ? 'Toutes sont en marche' : `${d.summary.total - d.summary.active} à l’arrêt`} />
                <Stat label="Temps gagné ce mois" value={fmtDuration(d.summary.minutes_saved_month)}
                  hint={d.summary.minutes_saved_month >= 480 ? `Soit environ ${fmtNum(Math.round(d.summary.minutes_saved_month / 480))} journées de travail` : 'Temps que vous n’avez pas passé à le faire à la main'} />
                <Stat label="Taux de réussite (30 jours)" value={fmtPct(d.summary.success_rate_30d)} tone={rateTone(d.summary.success_rate_30d)}
                  hint={d.summary.executions_30d ? `Sur ${fmtNum(d.summary.executions_30d)} passages` : 'Aucun passage sur la période'} />
              </div>
            )}
            {d.workflows.length === 0
              ? <div className="card"><Empty>Aucune automatisation pour le moment.<br />Dès que Jadip Services aura mis en place votre première automatisation, vous la verrez ici.</Empty></div>
              : (
                <section aria-labelledby="wf-list">
                  <h2 id="wf-list" className="sr-only">Liste de vos automatisations</h2>
                  <div className="grid auto">
                    {d.workflows.map((w) => <WfCardView key={w.id} w={w} onToggle={ctl.change} busy={ctl.busy} />)}
                  </div>
                </section>
              )}
          </>
        )}
      </Async>
      {ctl.dialog}
    </div>
  );
}

function Banner({ d }: { d: HomeData }) {
  const { active, total, incidents_7d } = d.summary;
  const stopped = total - active;
  const stoppedNote = stopped > 0 && active > 0 ? ` ${stopped === 1 ? 'Une automatisation est' : `${stopped} automatisations sont`} actuellement à l’arrêt.` : '';
  let tone: 'good' | 'warn' | 'idle';
  let icon: string;
  let title: string;
  let sub: string;
  if (total === 0) {
    tone = 'idle'; icon = '…'; title = 'Votre espace est prêt';
    sub = 'Vos automatisations apparaîtront ici dès leur mise en service.';
  } else if (active === 0) {
    tone = 'idle'; icon = '❚❚'; title = total === 1 ? 'Votre automatisation est à l’arrêt' : 'Toutes vos automatisations sont à l’arrêt';
    sub = 'Rien ne tourne pour le moment. Vous pouvez les réactiver ci-dessous à tout moment.';
  } else if (incidents_7d > 0) {
    tone = 'warn'; icon = '!';
    title = incidents_7d === 1 ? '1 incident cette semaine, notre équipe est prévenue' : `${fmtNum(incidents_7d)} incidents cette semaine, notre équipe est prévenue`;
    sub = `Vos automatisations continuent de fonctionner. Nous suivons chaque incident de près.${stoppedNote}`;
  } else {
    tone = 'good'; icon = '✓'; title = 'Tout fonctionne normalement';
    sub = `Aucun incident ces 7 derniers jours.${stoppedNote}`;
  }
  return (
    <div className={`p-banner ${tone}`} role="status">
      <span className="icon" aria-hidden="true">{icon}</span>
      <div>
        <div className="t">{title}</div>
        <div className="s">{sub}</div>
      </div>
    </div>
  );
}

function WfCardView({ w, onToggle, busy }: { w: WfCard; onToggle: (w: WfCard, v: boolean) => void; busy: boolean }) {
  const tone = rateTone(w.success_rate_30d);
  return (
    <article className="card wf-card p-wf">
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <h3 className="title" style={{ margin: 0 }}><Link to={`/portail/automatisations/${w.id}`}>{w.name}</Link></h3>
          <div style={{ marginTop: '.25rem' }}><WfState w={w} /></div>
        </div>
        <div className="above"><WfToggle w={w} onChange={onToggle} busy={busy} /></div>
      </div>
      {w.description && <p className="desc" style={{ margin: 0 }}>{w.description}</p>}
      <div className="facts">
        <div><div className="k">Dernier passage</div><div className="v">{shortAgo(w.last_execution_at)}</div></div>
        <div><div className="k">Réussite 30 j</div><div className={`v ${tone ?? ''}`}>{w.executions_30d ? fmtPct(w.success_rate_30d) : '—'}</div></div>
        <div><div className="k">Gagné ce mois</div><div className="v">{fmtDuration(w.minutes_saved_month)}</div></div>
      </div>
      <div className="foot">
        <span className="small" style={{ color: 'var(--warn)' }}>{w.last_status === 'Incident' ? 'Dernier passage : incident' : ''}</span>
        <span className="more" aria-hidden="true">Voir le détail →</span>
      </div>
    </article>
  );
}
