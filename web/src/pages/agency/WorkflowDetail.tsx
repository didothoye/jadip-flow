import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDate, fmtDateTime, fmtDuration, fmtMs, fmtNum, fmtUsd } from '../../lib/format';
import { Async, Badge, Card, Empty, PageHead, Stat, useAction } from '../../components/ui';
import { DailyBars } from '../../components/charts';
import {
  ActionLogTable, CategoryCounts, ErrorTable, EVENT_LABELS, ExecutionTable, PillTabs, Rate, Tabs, toNum, numStr, useClientList, useCursorList, useTab, WorkflowSwitch,
  type ActionRow, type ClientLite, type ErrorRow, type ExecRow,
} from './shared';

interface Detail {
  workflow: any; series: { day: string; total: number; success: number; failed: number }[]; errors: ErrorRow[]; categories: { category: string; n: number }[];
  events: { id: number; kind: string; detail: any; created_at: string }[]; actions: ActionRow[]; n8n_url: string;
}

const TABS = ['apercu', 'presentation', 'executions', 'erreurs', 'historique'] as const;
type Tab = (typeof TABS)[number];

export default function WorkflowDetail() {
  const { id } = useParams();
  const r = useApi<Detail>(`/api/admin/workflows/${id}`);
  const [tab, setTab] = useTab<Tab>(TABS, 'apercu');
  const { clients } = useClientList();
  useTitle(r.data?.workflow.name ?? 'Workflow');
  return (
    <div className="stack">
      <Async {...r}>
        {(d) => {
          const w = d.workflow;
          const unhandled = w.unhandled_errors_7d as number;
          return (
            <>
              <PageHead crumb={<><Link to="/agence/workflows">Workflows</Link>{w.client_id && <> · <Link to={`/agence/clients/${w.client_id}`}>{w.client_name}</Link></>}</>}
                title={w.name}
                sub={<span className="row" style={{ gap: '.4rem' }}>
                  {w.display_name && <span>Portail : « {w.display_name} »</span>}
                  <span>· {w.instance_name} (n° {w.n8n_id})</span>
                  {!w.client_id && <Badge tone="warn">Non rattaché</Badge>}
                  {w.deleted_at && <Badge tone="warn">Supprimé dans n8n le {fmtDate(w.deleted_at)}</Badge>}
                  {w.paused_until && <Badge tone="warn">En pause jusqu’au {fmtDateTime(w.paused_until)}</Badge>}
                  {(w.tags ?? []).map((t: string) => <Badge key={t}>{t}</Badge>)}
                </span>}
                actions={<>
                  <WorkflowSwitch wf={w} withLabel onChanged={() => r.reload()} />
                  <a className="btn" href={d.n8n_url} target="_blank" rel="noopener noreferrer">Ouvrir dans n8n ↗</a>
                </>} />
              <div className="ag-kpis cols-3">
                <Stat label="Exécutions 30 j" value={fmtNum(w.exec_30d)} hint={`${fmtNum(w.fail_30d)} échec(s)`} />
                <Stat label="Taux de réussite 30 j" value={<Rate value={w.success_rate_30d} />} />
                <Stat label="Durée moyenne" value={fmtMs(w.avg_ms)} />
                <Stat label="Temps gagné ce mois" value={fmtDuration(w.minutes_saved_month)} hint={`${numStr(w.minutes_saved_per_execution) || '0'} min par exécution réussie`} />
                <Stat label="Erreurs non traitées" value={fmtNum(w.unhandled_errors_7d)} tone={w.unhandled_errors_7d ? 'bad' : 'good'} hint="Sur 7 jours" />
                <Stat label="Coût estimé / exécution" value={fmtUsd(w.cost_per_execution_usd)} />
              </div>
              <div>
                <Tabs<Tab> value={tab} onChange={setTab} tabs={[
                  ['apercu', 'Aperçu'], ['presentation', 'Présentation au client'], ['executions', 'Exécutions'],
                  ['erreurs', `Erreurs${unhandled ? ` (${unhandled})` : ''}`], ['historique', 'Historique'],
                ]} />
                {tab === 'apercu' && (
                  <div className="ag-2-1">
                    <Card title="Exécutions des 30 derniers jours"><DailyBars data={d.series} /></Card>
                    <Card title="Erreurs par catégorie (30 j)"><CategoryCounts rows={d.categories} /></Card>
                  </div>
                )}
                {tab === 'presentation' && <PresentationForm w={w} clients={clients} onSaved={r.reload} />}
                {tab === 'executions' && <Executions workflowId={w.id} onChanged={r.reload} />}
                {tab === 'erreurs' && <Card title="Erreurs récentes"><ErrorTable rows={d.errors} onChanged={r.reload} showWorkflow={false} showClient={false} empty="Aucune erreur récente pour ce workflow." /></Card>}
                {tab === 'historique' && (
                  <div className="grid cols-2">
                    <Card title="Événements">
                      {d.events.length ? (
                        <ul className="timeline">
                          {d.events.map((e) => <li key={e.id}><span className="when">{fmtDateTime(e.created_at)}</span><span>{EVENT_LABELS[e.kind] ?? e.kind}{eventDetail(e, clients)}</span></li>)}
                        </ul>
                      ) : <Empty>Aucun événement.</Empty>}
                    </Card>
                    <Card title="Journal des actions"><ActionLogTable rows={d.actions} showWorkflow={false} /></Card>
                  </div>
                )}
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}

function eventDetail(e: { kind: string; detail: any }, clients: ClientLite[]) {
  const x = e.detail ?? {};
  if (e.kind === 'renamed' && x.from) return <span className="muted"> : « {x.from} » → « {x.to} »</span>;
  if (e.kind === 'assigned') {
    const c = clients.find((k) => k.id === x.clientId);
    return <span className="muted"> : {x.clientId ? c?.name ?? 'client' : 'aucun client'}{x.via === 'tag' ? ' (par étiquette)' : x.by ? ` (par ${x.by})` : ''}</span>;
  }
  if ((e.kind === 'activated' || e.kind === 'deactivated') && x.by) return <span className="muted"> par {x.by}{x.reason ? ` — ${x.reason}` : ''}</span>;
  if (e.kind === 'created' && x.name) return <span className="muted"> : « {x.name} »</span>;
  return null;
}

function Executions({ workflowId, onChanged }: { workflowId: string; onChanged: () => void }) {
  const [status, setStatus] = useState<'' | 'success' | 'failed'>('');
  const list = useCursorList<ExecRow>(`/api/admin/executions${qs({ workflow_id: workflowId, status, limit: 50 })}`);
  return (
    <Card title="Exécutions" actions={<PillTabs label="Statut" value={status} onChange={setStatus} options={[['', 'Toutes'], ['success', 'Réussies'], ['failed', 'Échecs']]} />}>
      <ExecutionTable list={list} showWorkflow={false} onChanged={() => { list.reload(); onChanged(); }} />
    </Card>
  );
}

function PresentationForm({ w, clients, onSaved }: { w: any; clients: ClientLite[]; onSaved: () => void }) {
  const { run, busy } = useAction();
  const assignValue = w.client_assignment === 'manual' ? (w.client_id ?? '__none') : 'tag';
  const init = useMemo(() => ({
    display_name: w.display_name ?? '', description: w.description ?? '', minutes: numStr(w.minutes_saved_per_execution), cost: numStr(w.cost_per_execution_usd),
    is_locked: w.is_locked, client_visible: w.client_visible, client_can_toggle: w.client_can_toggle, client_can_retry: w.client_can_retry, assign: assignValue,
  }), [w, assignValue]);
  const [f, setF] = useState(init);
  const chk = (k: 'is_locked' | 'client_visible' | 'client_can_toggle' | 'client_can_retry') => ({ checked: f[k], onChange: (e: { target: { checked: boolean } }) => setF({ ...f, [k]: e.target.checked }) });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      display_name: f.display_name.trim() || null, description: f.description.trim() || null,
      minutes_saved_per_execution: toNum(f.minutes) ?? 0, cost_per_execution_usd: toNum(f.cost) ?? 0,
      is_locked: f.is_locked, client_visible: f.client_visible, client_can_toggle: f.client_can_toggle, client_can_retry: f.client_can_retry,
    };
    if (f.assign !== init.assign) {
      if (f.assign === 'tag') body.assignment = 'tag';
      else body.client_id = f.assign === '__none' ? null : f.assign;
    }
    if (await run(() => api.patch(`/api/admin/workflows/${w.id}`, body), 'Présentation enregistrée.')) onSaved();
  };
  const tagHint = (w.tags ?? []).find((t: string) => t.replace(/\s/g, '').toLowerCase().startsWith('client:'));
  return (
    <div className="ag-2-1">
      <Card title="Présentation au client">
        <form className="form" onSubmit={save}>
          <label className="field">Nom affiché au client<span className="help">Laissez vide pour afficher le nom n8n (« {w.name} »).</span>
            <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} placeholder={w.name} maxLength={200} />
          </label>
          <label className="field">Description pour le client<span className="help">En langage simple : ce que fait l’automatisation et ce qu’elle lui apporte.</span>
            <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} placeholder="Ex. : Chaque commande reçue sur WhatsApp est ajoutée automatiquement au tableau de suivi." />
          </label>
          <div className="form-grid">
            <label className="field">Minutes gagnées par exécution réussie<span className="help">Sert au calcul du temps gagné.</span>
              <input inputMode="decimal" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} placeholder="0" />
            </label>
            <label className="field">Coût IA estimé par exécution ($US)<span className="help">Utilisé quand le fournisseur n’expose pas l’usage réel.</span>
              <input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="0" />
            </label>
          </div>
          <label className="field">Client
            <span className="help">{tagHint ? <>Étiquette détectée : <span className="mono">{tagHint}</span>.</> : <>Aucune étiquette <span className="mono">client:…</span> sur ce workflow.</>}</span>
            <select value={f.assign} onChange={(e) => setF({ ...f, assign: e.target.value })}>
              <option value="tag">Automatique par étiquette{w.client_assignment !== 'manual' && w.client_name ? ` (actuellement : ${w.client_name})` : ''}</option>
              <option value="__none">Aucun client (forcé)</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="ag-form-section">
            <h3>Visibilité et droits</h3>
            <div className="ag-checks">
              <label className="check"><input type="checkbox" {...chk('client_visible')} /><span>Visible dans le portail du client</span></label>
              <label className="check"><input type="checkbox" {...chk('client_can_toggle')} disabled={!f.client_visible} /><span>Le client peut l’activer / la désactiver</span></label>
              <label className="check"><input type="checkbox" {...chk('client_can_retry')} disabled={!f.client_visible} /><span>Le client peut relancer une exécution</span></label>
              <label className="check"><input type="checkbox" {...chk('is_locked')} /><span>Critique : désactivation interdite <span className="ag-sub">Même par l’agence, tant que cette case est cochée.</span></span></label>
            </div>
            <p className="muted small" style={{ margin: '.5rem 0 0' }}>Les droits du client s’appliquent seulement si ses paramètres généraux les autorisent aussi.</p>
          </div>
          <div className="ag-form-foot">
            <button type="button" className="btn" onClick={() => setF(init)} disabled={busy}>Annuler les modifications</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </form>
      </Card>
      <Card title="Aperçu dans le portail">
        <div className="wf-card">
          <div className="title">{f.display_name.trim() || w.name}</div>
          <div className="desc">{f.description.trim() || <span className="muted">Aucune description.</span>}</div>
          <div className="facts">
            <div><div className="k">Ce mois</div><div className="v">{fmtNum(w.ok_month)}</div></div>
            <div><div className="k">Réussite</div><div className="v"><Rate value={w.success_rate_30d} /></div></div>
            <div><div className="k">Temps gagné</div><div className="v">{fmtDuration((toNum(f.minutes) ?? 0) * (w.ok_month ?? 0))}</div></div>
          </div>
          {!f.client_visible && <div className="alert warn small">Ce workflow est masqué : le client ne le voit pas.</div>}
        </div>
      </Card>
    </div>
  );
}
