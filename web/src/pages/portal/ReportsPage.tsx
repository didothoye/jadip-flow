import { useAuth } from '../../lib/auth';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDate, fmtDuration, fmtNum, fmtPct, fmtUsd, periodLabel } from '../../lib/format';
import { Async, PageHead } from '../../components/ui';
import { cap, NotAvailable, rateTone } from './shared';

interface Report { id: string; period: string; created_at: string; totals: { executions: number; success: number; failed: number; successRate: number | null; minutesSaved: number; costUsd: number } | null }

export default function ReportsPage() {
  useTitle('Rapports');
  const { user } = useAuth();
  const allowed = !!user?.show_reports;
  const { data, error, loading } = useApi<Report[]>(allowed ? '/api/portal/reports' : null);
  return (
    <div className="stack">
      <PageHead title="Vos rapports mensuels" sub="Chaque mois, un bilan de ce que vos automatisations ont fait pour vous." />
      {!allowed ? <NotAvailable>Les rapports ne sont pas activés pour votre compte.</NotAvailable> : (
        <Async data={data} error={error} loading={loading}>
          {(list) => list.length === 0
            ? <NotAvailable>Aucun rapport pour le moment.<br />Votre premier bilan mensuel apparaîtra ici au début du mois prochain.</NotAvailable>
            : (
              <div className="grid cols-2">
                {list.map((r) => {
                  const t = r.totals;
                  const tone = rateTone(t?.successRate);
                  return (
                    <article key={r.id} className="card p-report">
                      <div className="row between">
                        <h2 style={{ margin: 0 }}>{cap(periodLabel(r.period))}</h2>
                        <span className="small muted">Publié le {fmtDate(r.created_at)}</span>
                      </div>
                      {t ? (
                        <div className="figs">
                          <div><div className="k">Passages</div><div className="v">{fmtNum(t.executions)}</div></div>
                          <div><div className="k">Réussite</div><div className="v" style={{ color: tone ? `var(--${tone})` : undefined }}>{fmtPct(t.successRate)}</div></div>
                          <div><div className="k">Temps gagné</div><div className="v">{fmtDuration(t.minutesSaved)}</div></div>
                          {user?.show_costs && <div><div className="k">Coûts IA</div><div className="v">{fmtUsd(t.costUsd)}</div></div>}
                        </div>
                      ) : <p className="muted small">Chiffres clés indisponibles.</p>}
                      <div className="p-actions">
                        <a className="btn primary" href={`/api/portal/reports/${r.id}/pdf`} download aria-label={`Télécharger le rapport de ${periodLabel(r.period)} en PDF`}>⬇ PDF</a>
                        <a className="btn" href={`/api/portal/reports/${r.id}/xlsx`} download aria-label={`Télécharger le rapport de ${periodLabel(r.period)} en Excel`}>⬇ Excel</a>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
        </Async>
      )}
    </div>
  );
}
