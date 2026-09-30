import { useAuth } from '../../lib/auth';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtPct, fmtUsd, periodLabel } from '../../lib/format';
import { Async, Card, Empty, PageHead } from '../../components/ui';
import { ShareBar } from '../../components/charts';
import { cap, NotAvailable } from './shared';

interface Costs { period: string; budget_usd: number | null; month_total_usd: number; by_workflow: { name: string; cost_usd: number }[]; history: { period: string; cost_usd: number }[] }

export default function CostsPage() {
  useTitle('Coûts');
  const { user } = useAuth();
  const allowed = !!user?.show_costs;
  const { data, error, loading } = useApi<Costs>(allowed ? '/api/portal/costs' : null);
  return (
    <div className="stack">
      <PageHead title="Coûts des services d’IA" sub="Ce que consomment vos automatisations auprès des services d’intelligence artificielle." />
      {!allowed ? <NotAvailable>Le suivi des coûts n’est pas activé pour votre compte.</NotAvailable> : (
        <Async data={data} error={error} loading={loading}>
          {(d) => <CostsView d={d} />}
        </Async>
      )}
    </div>
  );
}

function CostsView({ d }: { d: Costs }) {
  const budget = d.budget_usd && d.budget_usd > 0 ? d.budget_usd : null;
  const ratio = budget ? d.month_total_usd / budget : null;
  const tone = ratio == null ? '' : ratio > 1 ? 'bad' : ratio > 0.8 ? 'warn' : '';
  const maxW = Math.max(0, ...d.by_workflow.map((x) => x.cost_usd));
  const maxH = Math.max(0, ...d.history.map((x) => x.cost_usd));
  const history = [...d.history].reverse();
  return (
    <>
      <div className="grid cols-2">
        <Card title={`Ce mois-ci · ${cap(periodLabel(d.period))}`}>
          <div className="p-big">{fmtUsd(d.month_total_usd)}</div>
          {budget ? (
            <>
              <div className="muted" style={{ margin: '.2rem 0 .8rem' }}>sur un budget mensuel de {fmtUsd(budget)}</div>
              <div className={`p-meter ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((ratio ?? 0) * 100)} aria-label="Part du budget utilisée">
                <div style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} />
              </div>
              <p className="small" style={{ margin: '.6rem 0 0', color: tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--text-2)' }}>
                {ratio! > 1
                  ? `Le budget prévu est dépassé (${fmtPct(ratio)}). Écrivez-nous si vous souhaitez en parler.`
                  : ratio! > 0.8
                    ? `${fmtPct(ratio)} du budget déjà utilisé : vous approchez de la limite prévue.`
                    : `${fmtPct(ratio)} du budget utilisé. Tout est dans les limites prévues.`}
              </p>
            </>
          ) : <div className="muted" style={{ marginTop: '.3rem' }}>Aucun budget mensuel n’a été défini.</div>}
        </Card>
        <Card title="À quoi correspondent ces coûts ?">
          <p>Certaines automatisations font appel à des services d’intelligence artificielle, par exemple pour <strong>résumer un texte, trier des messages ou rédiger une réponse</strong>.</p>
          <p>Ces services sont facturés à l’usage, par les fournisseurs d’IA, en dollars américains. Plus une automatisation travaille, plus son coût augmente.</p>
          <p className="small muted" style={{ margin: 0 }}>Les montants sont mis à jour chaque jour. « Autres usages » regroupe les usages qui ne sont pas liés à une automatisation précise.</p>
        </Card>
      </div>
      <Card title="Répartition ce mois-ci">
        {d.by_workflow.length === 0 ? <Empty>Aucun coût enregistré ce mois-ci.</Empty> : (
          <ul className="p-rows">
            {d.by_workflow.map((w) => (
              <li key={w.name} className="p-share">
                <span>{w.name}</span>
                <span className="amt">{fmtUsd(w.cost_usd)} <span className="small muted" style={{ fontWeight: 400 }}>· {fmtPct(d.month_total_usd ? w.cost_usd / d.month_total_usd : 0)}</span></span>
                <div className="bar"><ShareBar value={w.cost_usd} max={maxW} /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Mois précédents">
        {history.length === 0 ? <Empty>Pas encore d’historique.</Empty> : (
          <ul className="p-rows">
            {history.map((h) => (
              <li key={h.period} className="p-share">
                <span>{cap(periodLabel(h.period))}{h.period === d.period && <span className="small muted"> (en cours)</span>}</span>
                <span className="amt">{fmtUsd(h.cost_usd)}</span>
                <div className="bar"><ShareBar value={h.cost_usd} max={Math.max(maxH, budget ?? 0)} tone={budget && h.cost_usd > budget ? 'var(--bad)' : undefined} /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
