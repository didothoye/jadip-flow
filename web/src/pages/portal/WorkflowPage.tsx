import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtDuration, fmtMs, fmtNum, fmtPct, fromNow } from '../../lib/format';
import { Async, Badge, Card, Empty, ErrorBox, Loading, PageHead, Stat, useAction, useUi } from '../../components/ui';
import { DailyBars } from '../../components/charts';
import { cap, LockedTag, rateTone, useWorkflowControls, WfState, type WfCard } from './shared';

interface Exec { id: number; status: string; status_label: string; started_at: string; duration_ms: number | null; explanation: string | null; retried: boolean; handled: boolean }
interface Detail { workflow: WfCard; series: { day: string; total: number; success: number; failed: number }[]; executions: Exec[]; next_cursor: string | null }
type Filter = 'all' | 'success' | 'failed';

export default function WorkflowPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<Detail>(`/api/portal/workflows/${id}`, [id]);
  useTitle(data?.workflow.name ?? 'Automatisation');
  const ctl = useWorkflowControls(reload);
  return (
    <div className="stack">
      <Async data={data} error={error} loading={loading}>
        {(d) => {
          const w = d.workflow;
          const actions = w.locked
            ? <LockedTag />
            : w.can_toggle
              ? (w.active
                ? <button className="btn p-lg" onClick={() => ctl.change(w, false)} disabled={ctl.busy}>❚❚ Mettre en pause</button>
                : <button className="btn primary p-lg" onClick={() => ctl.change(w, true)} disabled={ctl.busy}>▶ Réactiver</button>)
              : null;
          return (
            <>
              <PageHead
                crumb={<Link to="/portail">← Vos automatisations</Link>}
                title={w.name}
                sub={<><div style={{ marginBottom: '.35rem' }}>{w.description}</div><WfState w={w} /></>}
                actions={actions}
              />
              <div className="grid cols-4 p-stats p-stats4">
                <Stat label="Passages (30 jours)" value={fmtNum(w.executions_30d)} hint={w.last_execution_at ? `Dernier ${fromNow(w.last_execution_at)}` : 'Aucun passage pour le moment'} />
                <Stat label="Taux de réussite" value={w.executions_30d ? fmtPct(w.success_rate_30d) : '—'} tone={rateTone(w.success_rate_30d)} hint="Sur les 30 derniers jours" />
                <Stat label="Incidents (30 jours)" value={fmtNum(w.failures_30d)} tone={w.failures_30d ? 'warn' : 'good'} hint={w.failures_30d ? 'Notre équipe est prévenue à chaque fois' : 'Aucun incident'} />
                <Stat label="Temps gagné ce mois" value={fmtDuration(w.minutes_saved_month)} hint="Travail fait à votre place" />
              </div>
              <Card title="Activité des 30 derniers jours">
                {d.series.some((s) => s.total > 0)
                  ? <DailyBars data={d.series} />
                  : <Empty>Aucune activité ces 30 derniers jours.</Empty>}
              </Card>
              <History wf={w} initial={d} onChanged={reload} />
              <div className="card row between p-help">
                <div>
                  <strong>Une question ou un souci ?</strong>
                  <div className="small muted">Notre équipe vous répond rapidement.</div>
                </div>
                <Link className="btn p-lg" to={`/portail/demandes/nouvelle?automatisation=${w.id}`}>Signaler un problème sur cette automatisation</Link>
              </div>
            </>
          );
        }}
      </Async>
      {ctl.dialog}
    </div>
  );
}

function History({ wf, initial, onChanged }: { wf: WfCard; initial: Detail; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<Exec[]>(initial.executions);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm } = useUi();
  const { run, busy } = useAction();

  const load = async (f: Filter, from: string | null) => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Exec[]; next_cursor: string | null }>(`/api/portal/workflows/${wf.id}/executions${qs({ cursor: from, status: f === 'all' ? undefined : f })}`);
      setItems((prev) => (from ? [...prev, ...r.items] : r.items));
      setCursor(r.next_cursor);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (filter === 'all') { setItems(initial.executions); setCursor(initial.next_cursor); setErr(null); }
    else load(filter, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, initial]);

  const retry = async (e: Exec) => {
    const r = await confirm({
      title: 'Relancer ce passage ?',
      message: <p style={{ margin: 0 }}>L’automatisation va refaire le traitement qui a échoué le {fmtDateTime(e.started_at)}, avec les mêmes informations. Le résultat apparaîtra dans l’historique d’ici quelques instants.</p>,
      confirmLabel: 'Relancer',
    });
    if (!r.ok) return;
    const ok = await run(() => api.post(`/api/portal/executions/${e.id}/retry`), 'Relance demandée. Le résultat apparaîtra dans l’historique d’ici quelques instants.');
    if (ok) setTimeout(onChanged, 1500);
  };

  const tabs: [Filter, string][] = [['all', 'Tout'], ['success', 'Réussites'], ['failed', 'Incidents']];
  return (
    <Card title="Historique" actions={
      <div className="pill-tabs" role="tablist" aria-label="Filtrer l’historique">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
    }>
      <ErrorBox error={err} />
      {loading && !items.length ? <Loading /> : !items.length ? (
        <Empty>{filter === 'failed' ? 'Aucun incident récent. 🎉' : filter === 'success' ? 'Aucun passage réussi à afficher.' : 'Aucun passage pour le moment.'}</Empty>
      ) : (
        <ul className="p-runs">
          {items.map((e) => {
            const failed = ['error', 'crashed'].includes(e.status);
            const tone = e.status === 'success' ? 'good' : failed ? 'bad' : 'warn';
            return (
              <li key={e.id}>
                <div className="line">
                  <span className={`p-sdot ${tone}`} aria-hidden="true" />
                  <strong style={{ color: failed ? 'var(--bad)' : undefined }}>{e.status_label}</strong>
                  <span className="when">{cap(fromNow(e.started_at))}</span>
                  <span className="small muted">{fmtDateTime(e.started_at)}{e.duration_ms != null && e.status === 'success' ? ` · ${fmtMs(e.duration_ms)}` : ''}</span>
                  {e.retried && <Badge tone="info">Nouvelle tentative</Badge>}
                  {failed && e.handled && <Badge tone="good">Pris en charge</Badge>}
                </div>
                {failed && e.explanation && (
                  <div className={`explain ${e.handled ? 'handled' : ''}`}>
                    {e.explanation}
                    {e.handled && <div className="small muted" style={{ marginTop: '.25rem' }}>Notre équipe s’en est occupée.</div>}
                  </div>
                )}
                {failed && wf.can_retry && (
                  <div><button className="btn small" style={{ minHeight: 38 }} onClick={() => retry(e)} disabled={busy}>↻ Relancer</button></div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <div style={{ textAlign: 'center', marginTop: '.8rem' }}>
          <button className="btn" onClick={() => load(filter, cursor)} disabled={loading}>{loading ? 'Chargement…' : 'Afficher plus'}</button>
        </div>
      )}
    </Card>
  );
}
