import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { Async, Badge, Card, Empty, Modal, PageHead, Switch, useAction, useUi } from '../../components/ui';
import { Ago, AlertStatusBadge, ClientSelect, PillTabs, SeverityBadge, Tabs, toNum, numStr, useClientList, useTab } from './shared';

export const RULE_KINDS: Record<string, { label: string; threshold: string | null; help: string }> = {
  execution_failed: { label: 'Échec d’exécution', threshold: null, help: 'Alerte dès qu’une exécution échoue.' },
  workflow_inactive: { label: 'Inactivité (jours)', threshold: 'Jours sans exécution', help: 'Workflow actif qui ne s’exécute plus. Pour une règle globale, le délai propre à chaque client prime.' },
  failure_rate: { label: 'Taux d’échec (%)', threshold: 'Taux d’échec maximal (%)', help: 'Proportion d’échecs sur la fenêtre d’observation.' },
  sync_failed: { label: 'Synchronisation en panne (échecs consécutifs)', threshold: 'Échecs consécutifs', help: 'L’instance n8n ne répond plus aux synchronisations.' },
  llm_budget: { label: 'Budget IA (% du budget)', threshold: '% du budget mensuel atteint', help: 'Consommation IA du client rapportée à son budget mensuel.' },
};
const CHANNELS: [string, string][] = [['app', 'Application'], ['telegram', 'Telegram'], ['email', 'E-mail']];
const minutes = (m: number) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} j` : m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

const TABS = ['alertes', 'regles'] as const;
type Tab = (typeof TABS)[number];

export default function Alerts() {
  useTitle('Alertes');
  const [tab, setTab] = useTab<Tab>(TABS, 'alertes');
  return (
    <div className="stack">
      <PageHead title="Alertes" sub={<>Les notifications Telegram et e-mail sont différées pendant les <Link to="/agence/parametres">heures calmes</Link>, sauf les alertes critiques.</>} />
      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[['alertes', 'Alertes'], ['regles', 'Règles']]} />
        {tab === 'alertes' ? <AlertList /> : <Rules />}
      </div>
    </div>
  );
}

function AlertList() {
  const [status, setStatus] = useState<'active' | 'resolved'>('active');
  const r = useApi<any[]>(`/api/admin/alerts${qs({ status })}`);
  const { run, busy } = useAction();
  const act = async (id: number, a: string, msg: string) => { if (await run(() => api.post(`/api/admin/alerts/${id}/${a}`), msg)) r.reload(); };
  return (
    <Card title={status === 'active' ? 'Alertes en cours' : 'Alertes résolues'} actions={<PillTabs label="Statut" value={status} onChange={setStatus} options={[['active', 'En cours'], ['resolved', 'Résolues']]} />}>
      <Async {...r}>
        {(rows) => rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Gravité</th><th>Alerte</th><th>Concerne</th><th className="num">Occurrences</th><th>Première / dernière</th><th>Statut</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td style={{ minWidth: 260 }}><strong>{a.title}</strong><span className="ag-sub" style={{ whiteSpace: 'pre-line' }}>{a.message}</span></td>
                    <td className="small">
                      {a.client_id && <Link to={`/agence/clients/${a.client_id}`} style={{ display: 'block' }}>{a.client_name}</Link>}
                      {a.workflow_id && <Link to={`/agence/workflows/${a.workflow_id}`} style={{ display: 'block' }}>{a.workflow_name}</Link>}
                      {a.instance_id && <Link to="/agence/instances" style={{ display: 'block' }}>{a.instance_name}</Link>}
                      {!a.client_id && !a.workflow_id && !a.instance_id && <span className="muted">—</span>}
                    </td>
                    <td className="num">{fmtNum(a.occurrences)}</td>
                    <td className="small nowrap"><span title={fmtDateTime(a.first_seen_at)}>{fmtDateTime(a.first_seen_at)}</span><span className="ag-sub"><Ago at={a.last_seen_at} /></span></td>
                    <td><AlertStatusBadge status={a.status} />{a.resolved_at && <span className="ag-sub">{fmtDateTime(a.resolved_at)}</span>}</td>
                    <td className="actions">
                      {a.status === 'open' && <button className="btn small" disabled={busy} onClick={() => act(a.id, 'acknowledge', 'Alerte prise en compte.')}>Prendre en compte</button>}
                      {a.status !== 'resolved'
                        ? <button className="btn small" disabled={busy} onClick={() => act(a.id, 'resolve', 'Alerte résolue.')}>Résoudre</button>
                        : <button className="btn small" disabled={busy} onClick={() => act(a.id, 'reopen', 'Alerte rouverte.')}>Rouvrir</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{status === 'active' ? 'Aucune alerte en cours.' : 'Aucune alerte résolue.'}</Empty>}
      </Async>
    </Card>
  );
}

interface Rule {
  id: string; name: string; kind: string; client_id: string | null; workflow_id: string | null; threshold: number | null; window_hours: number;
  group_minutes: number; repeat_minutes: number; channels: string[]; enabled: boolean; client_name: string | null; workflow_name: string | null;
}

function Rules() {
  const r = useApi<Rule[]>('/api/admin/alert-rules');
  const { run } = useAction();
  const { confirm } = useUi();
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const toggle = async (x: Rule, on: boolean) => { if (await run(() => api.patch(`/api/admin/alert-rules/${x.id}`, { enabled: on }), on ? 'Règle activée.' : 'Règle désactivée.')) r.reload(); };
  const remove = async (x: Rule) => {
    const c = await confirm({ title: 'Supprimer la règle', danger: true, confirmLabel: 'Supprimer', message: <>La règle « {x.name} » sera supprimée. Les alertes déjà créées sont conservées.</> });
    if (c.ok && await run(() => api.del(`/api/admin/alert-rules/${x.id}`), 'Règle supprimée.')) r.reload();
  };
  return (
    <Card title="Règles d’alerte" actions={<button className="btn primary" onClick={() => setEdit('new')}>Nouvelle règle</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Une règle propre à un client ou à un workflow complète les règles globales. Le regroupement anti-bruit évite une notification par échec ; le délai de répétition relance une alerte restée ouverte.</p>
      <Async {...r}>
        {(rows) => rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Active</th><th>Règle</th><th>Portée</th><th className="num">Seuil</th><th>Regroupement / répétition</th><th>Canaux</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id} className={x.enabled ? '' : 'muted-row'}>
                    <td><Switch checked={x.enabled} onChange={(v) => toggle(x, v)} label={`${x.enabled ? 'Désactiver' : 'Activer'} la règle « ${x.name} »`} /></td>
                    <td><strong>{x.name}</strong><span className="ag-sub">{RULE_KINDS[x.kind]?.label ?? x.kind}</span></td>
                    <td className="small">{x.workflow_id ? <>Workflow : <Link to={`/agence/workflows/${x.workflow_id}`}>{x.workflow_name}</Link></> : x.client_id ? <>Client : <Link to={`/agence/clients/${x.client_id}`}>{x.client_name}</Link></> : <Badge>Globale</Badge>}</td>
                    <td className="num">{x.threshold == null ? '—' : fmtNum(x.threshold, 2)}{x.kind === 'failure_rate' && <span className="ag-sub">sur {x.window_hours} h</span>}</td>
                    <td className="small">{minutes(x.group_minutes)} / {minutes(x.repeat_minutes)}</td>
                    <td><span className="ag-tags">{x.channels.map((c) => <Badge key={c}>{CHANNELS.find(([k]) => k === c)?.[1] ?? c}</Badge>)}</span></td>
                    <td className="actions">
                      <button className="btn small" onClick={() => setEdit(x)}>Modifier</button>
                      <button className="btn small danger" onClick={() => remove(x)}>Supprimer</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Aucune règle. Sans règle, aucune alerte n’est créée.</Empty>}
      </Async>
      {edit && <RuleModal rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); r.reload(); }} />}
    </Card>
  );
}

function RuleModal({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const { clients } = useClientList();
  const [f, setF] = useState({
    name: rule?.name ?? '', kind: rule?.kind ?? 'execution_failed',
    scope: rule?.workflow_id ? 'workflow' : rule?.client_id ? 'client' : 'global',
    client_id: rule?.client_id ?? '', workflow_id: rule?.workflow_id ?? '',
    threshold: numStr(rule?.threshold), window_hours: String(rule?.window_hours ?? 24), group_minutes: String(rule?.group_minutes ?? 15),
    repeat_minutes: String(rule?.repeat_minutes ?? 240), channels: rule?.channels ?? ['app', 'telegram'], enabled: rule?.enabled ?? true,
  });
  const wfs = useApi<{ id: string; name: string; display_name: string | null; client_name: string | null }[]>(f.scope === 'workflow' ? `/api/admin/workflows${qs({ client_id: f.client_id })}` : null, [f.scope]);
  const kind = RULE_KINDS[f.kind];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: f.name.trim(), kind: f.kind,
      client_id: f.scope === 'global' ? null : f.client_id || null,
      workflow_id: f.scope === 'workflow' ? f.workflow_id || null : null,
      threshold: kind.threshold ? toNum(f.threshold) : null,
      window_hours: parseInt(f.window_hours, 10) || 24, group_minutes: parseInt(f.group_minutes, 10) || 0, repeat_minutes: parseInt(f.repeat_minutes, 10) || 240,
      channels: f.channels, enabled: f.enabled,
    };
    const ok = await run(() => (rule ? api.patch(`/api/admin/alert-rules/${rule.id}`, body) : api.post('/api/admin/alert-rules', body)), rule ? 'Règle enregistrée.' : 'Règle créée.');
    if (ok) onSaved();
  };
  const invalid = !f.name.trim() || !f.channels.length || (f.scope === 'client' && !f.client_id) || (f.scope === 'workflow' && !f.workflow_id) || (!!kind.threshold && toNum(f.threshold) == null);
  return (
    <Modal title={rule ? 'Modifier la règle' : 'Nouvelle règle d’alerte'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex. : Échecs chez Kivu" /></label>
        <label className="field">Type<span className="help">{kind.help}</span>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(RULE_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </label>
        <label className="field">Portée
          <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            <option value="global">Globale (tous les clients)</option><option value="client">Un client</option><option value="workflow">Un workflow</option>
          </select>
        </label>
        {f.scope !== 'global' && (
          <label className="field">Client<ClientSelect value={f.client_id} onChange={(v) => setF({ ...f, client_id: v, workflow_id: '' })} clients={clients} allLabel={f.scope === 'workflow' ? 'Tous les clients' : 'Choisir un client'} /></label>
        )}
        {f.scope === 'workflow' && (
          <label className="field">Workflow
            <select value={f.workflow_id} onChange={(e) => setF({ ...f, workflow_id: e.target.value })} required>
              <option value="">Choisir un workflow</option>
              {(wfs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.display_name || w.name}{w.client_name ? ` — ${w.client_name}` : ''}</option>)}
            </select>
          </label>
        )}
        <div className="form-grid">
          {kind.threshold && <label className="field">{kind.threshold}<input inputMode="decimal" required value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} /></label>}
          {f.kind === 'failure_rate' && <label className="field">Fenêtre d’observation (heures)<input type="number" min={1} max={720} value={f.window_hours} onChange={(e) => setF({ ...f, window_hours: e.target.value })} /></label>}
          <label className="field">Regroupement anti-bruit (minutes)<span className="help">Délai minimal entre deux notifications d’une même alerte.</span>
            <input type="number" min={0} max={1440} value={f.group_minutes} onChange={(e) => setF({ ...f, group_minutes: e.target.value })} /></label>
          <label className="field">Délai de répétition (minutes)<span className="help">Rappel si l’alerte reste ouverte sans prise en compte.</span>
            <input type="number" min={5} max={10080} value={f.repeat_minutes} onChange={(e) => setF({ ...f, repeat_minutes: e.target.value })} /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 500, marginBottom: '.35rem' }}>Canaux</legend>
          <div className="row">
            {CHANNELS.map(([k, l]) => (
              <label key={k} className="check"><input type="checkbox" checked={f.channels.includes(k)}
                onChange={(e) => setF({ ...f, channels: e.target.checked ? [...f.channels, k] : f.channels.filter((c) => c !== k) })} />{l}</label>
            ))}
          </div>
        </fieldset>
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Règle active</label>
        <div className="ag-form-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={busy || invalid}>{rule ? 'Enregistrer' : 'Créer la règle'}</button>
        </div>
      </form>
    </Modal>
  );
}
