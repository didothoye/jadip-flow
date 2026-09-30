import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDate, fmtNum, fmtUsd } from '../../lib/format';
import { Async, Badge, Card, Empty, Modal, PageHead, Stat, Switch, useAction, useUi } from '../../components/ui';
import { CostBars, ShareBar } from '../../components/charts';
import { Ago, ClientSelect, PillTabs, Tabs, toNum, useClientList, useTab, type ClientLite } from './shared';

const PROVIDERS: Record<string, string> = {
  openai: 'OpenAI (clé d’administration)', anthropic: 'Anthropic (clé Admin API)', openrouter: 'OpenRouter (clé de provisionnement)', manual: 'Saisie manuelle',
};
const PROVIDER_SHORT: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', manual: 'Manuel', estimation: 'Estimation' };
const DIMENSIONS: Record<string, string> = { api_key: 'Clé API', project: 'Projet', workspace: 'Espace de travail', model: 'Modèle' };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };

const TABS = ['repartition', 'comptes', 'attribution', 'manuel'] as const;
type Tab = (typeof TABS)[number];

export default function Costs() {
  useTitle('Coûts IA');
  const [tab, setTab] = useTab<Tab>(TABS, 'repartition');
  const { clients, all } = useClientList();
  return (
    <div className="stack">
      <PageHead title="Coûts IA" sub="Consommation des modèles d’IA, récupérée chez les fournisseurs, saisie à la main ou estimée par exécution." />
      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[['repartition', 'Répartition'], ['comptes', 'Comptes fournisseurs'], ['attribution', 'Attribution'], ['manuel', 'Saisie manuelle']]} />
        {tab === 'repartition' && <Breakdown clients={all} />}
        {tab === 'comptes' && <Accounts />}
        {tab === 'attribution' && <Attribution clients={clients} />}
        {tab === 'manuel' && <Manual clients={clients} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- répartition

function Breakdown({ clients }: { clients: ClientLite[] }) {
  const today = iso(new Date());
  const monthStart = `${today.slice(0, 8)}01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [client, setClient] = useState('');
  const preset = from === monthStart && to === today ? 'month' : from === addDays(today, -29) && to === today ? '30' : '';
  const setPreset = (p: string) => {
    if (p === 'month') { setFrom(monthStart); setTo(today); }
    else if (p === 'prev') { const d = new Date(); d.setDate(0); const end = iso(d); setFrom(`${end.slice(0, 8)}01`); setTo(end); }
    else if (p === '30') { setFrom(addDays(today, -29)); setTo(today); }
  };
  const r = useApi<any>(from && to && from <= to ? `/api/admin/costs${qs({ from, to: addDays(to, 1), client_id: client })}` : null);
  const names = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);
  return (
    <div className="stack">
      <Card>
        <div className="filters ag-filters" style={{ marginBottom: 0 }}>
          <PillTabs label="Période" value={preset} onChange={setPreset} options={[['month', 'Ce mois'], ['prev', 'Mois dernier'], ['30', '30 jours']]} />
          <label className="field">Du<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">Au<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <ClientSelect value={client} onChange={setClient} clients={clients.filter((c) => !c.archived_at)} />
        </div>
      </Card>
      <Async {...r}>
        {(d) => {
          const total = d.total?.cost_usd ?? 0;
          const un = d.total?.unattributed ?? 0;
          const maxC = Math.max(0, ...d.byClient.map((x: any) => x.cost_usd));
          const maxW = Math.max(0, ...d.byWorkflow.map((x: any) => x.cost_usd));
          const maxM = Math.max(0, ...d.byModel.map((x: any) => x.cost_usd));
          return (
            <>
              <div className="grid cols-3">
                <Stat label="Coût total" value={fmtUsd(total)} hint={`Du ${fmtDate(from)} au ${fmtDate(to)}`} />
                <Stat label="Attribué à un client" value={fmtUsd(total - un)} hint={total ? `${fmtNum(((total - un) / total) * 100)} % du total` : undefined} />
                <Stat label="Non attribué" value={fmtUsd(un)} tone={un > 0 ? 'warn' : undefined} hint={un > 0 ? <Link to="/agence/couts?onglet=attribution">Définir des règles d’attribution</Link> : 'Tout est attribué'} />
              </div>
              <Card title="Coût par jour"><CostBars data={d.byDay} /></Card>
              <div className="grid cols-2">
                <Card title="Par client">
                  {d.byClient.length ? (
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Client</th><th className="num">Coût</th><th style={{ width: '35%' }}>Part</th></tr></thead>
                      <tbody>{d.byClient.map((x: any) => (
                        <tr key={x.client_id ?? 'none'}>
                          <td>{x.client_id ? <Link to={`/agence/clients/${x.client_id}?onglet=couts`}>{x.client_name}</Link> : <span className="muted">Non attribué</span>}</td>
                          <td className="num">{fmtUsd(x.cost_usd)}</td>
                          <td><ShareBar value={x.cost_usd} max={maxC} tone={x.client_id ? undefined : 'var(--axis)'} /></td>
                        </tr>))}</tbody>
                    </table></div>
                  ) : <Empty>Aucun coût sur la période.</Empty>}
                </Card>
                <Card title="Par modèle">
                  {d.byModel.length ? (
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Modèle</th><th className="num">Jetons (entrée / sortie)</th><th className="num">Coût</th><th style={{ width: '25%' }}>Part</th></tr></thead>
                      <tbody>{d.byModel.map((x: any) => (
                        <tr key={`${x.provider}|${x.model}`}>
                          <td><span className="mono">{x.model}</span><span className="ag-sub">{PROVIDER_SHORT[x.provider] ?? x.provider}</span></td>
                          <td className="num small">{Number(x.input_tokens) || Number(x.output_tokens) ? `${fmtNum(x.input_tokens)} / ${fmtNum(x.output_tokens)}` : '—'}</td>
                          <td className="num">{fmtUsd(x.cost_usd)}</td>
                          <td><ShareBar value={x.cost_usd} max={maxM} /></td>
                        </tr>))}</tbody>
                    </table></div>
                  ) : <Empty>Aucun coût sur la période.</Empty>}
                </Card>
              </div>
              <Card title="Par workflow">
                {d.byWorkflow.length ? (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th>Workflow</th><th>Client</th><th className="num">Coût</th><th style={{ width: '30%' }}>Part</th></tr></thead>
                    <tbody>{d.byWorkflow.map((x: any, i: number) => (
                      <tr key={`${x.workflow_id ?? 'none'}|${x.client_id ?? ''}|${i}`}>
                        <td>{x.workflow_id ? <Link to={`/agence/workflows/${x.workflow_id}`}>{x.workflow_name}</Link> : <span className="muted">Sans workflow</span>}</td>
                        <td>{x.client_id ? names[x.client_id] ?? '—' : <span className="muted">Non attribué</span>}</td>
                        <td className="num">{fmtUsd(x.cost_usd)}</td>
                        <td><ShareBar value={x.cost_usd} max={maxW} /></td>
                      </tr>))}</tbody>
                  </table></div>
                ) : <Empty>Aucun coût sur la période.</Empty>}
                <p className="muted small" style={{ marginBottom: 0 }}>Pour un workflow dont le fournisseur n’expose pas l’usage réel, indiquez un coût estimé par exécution dans sa fiche (onglet « Présentation au client ») : il est multiplié par le nombre d’exécutions.</p>
              </Card>
            </>
          );
        }}
      </Async>
    </div>
  );
}

// ---------------------------------------------------------------- comptes fournisseurs

interface Account { id: string; provider: string; name: string; enabled: boolean; api_key_hint: string | null; last_fetch_at: string | null; last_fetch_status: string | null; last_fetch_message: string | null; rules: number }

function Accounts() {
  const r = useApi<Account[]>('/api/admin/llm/accounts');
  const { run } = useAction();
  const { confirm, toast } = useUi();
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fetchNow = async (a: Account) => {
    const c = await confirm({ title: `Récupérer les coûts de « ${a.name} »`, message: 'Les coûts des derniers jours seront importés depuis le fournisseur (les lignes déjà importées sont mises à jour).', confirmLabel: 'Récupérer', input: { label: 'Nombre de jours (1 à 90)', placeholder: '7' } });
    if (!c.ok) return;
    const days = Math.min(90, Math.max(1, parseInt(c.value || '7', 10) || 7));
    setBusyId(a.id);
    try {
      const res = await api.post<{ ok: boolean; imported?: number; message?: string }>(`/api/admin/llm/accounts/${a.id}/fetch`, { days });
      if (res.ok) toast(`${fmtNum(res.imported ?? 0)} ligne(s) importée(s).`); else toast(res.message ?? 'Échec de la récupération.', 'error');
      r.reload();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusyId(null); }
  };
  const remove = async (a: Account) => {
    const c = await confirm({ title: 'Supprimer le compte', danger: true, confirmLabel: 'Supprimer', message: <>Le compte « {a.name} », ses règles d’attribution et tous les coûts importés depuis ce compte seront supprimés.</> });
    if (c.ok && await run(() => api.del(`/api/admin/llm/accounts/${a.id}`), 'Compte supprimé.')) r.reload();
  };
  const toggle = async (a: Account, on: boolean) => { if (await run(() => api.patch(`/api/admin/llm/accounts/${a.id}`, { enabled: on }), on ? 'Compte activé.' : 'Compte désactivé.')) r.reload(); };
  return (
    <Card title="Comptes fournisseurs" actions={<button className="btn primary" onClick={() => setEdit('new')}>Ajouter un compte</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Les coûts sont récupérés automatiquement chaque jour. Utilisez une clé d’administration en lecture : elle est chiffrée et n’est jamais réaffichée.</p>
      <Async {...r}>
        {(rows) => rows.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Actif</th><th>Compte</th><th>Clé</th><th>Dernière récupération</th><th className="num">Règles</th><th className="right">Actions</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} className={a.enabled ? '' : 'muted-row'}>
                <td><Switch checked={a.enabled} onChange={(v) => toggle(a, v)} label={`${a.enabled ? 'Désactiver' : 'Activer'} « ${a.name} »`} /></td>
                <td><strong>{a.name}</strong><span className="ag-sub">{PROVIDERS[a.provider] ?? a.provider}</span></td>
                <td className="mono small">{a.api_key_hint ?? '—'}</td>
                <td className="small">
                  {a.last_fetch_at ? <><Ago at={a.last_fetch_at} />{' '}{a.last_fetch_status === 'success' ? <Badge tone="good">Réussie</Badge> : <Badge tone="bad">Échec</Badge>}
                    {a.last_fetch_message && <span className="ag-sub" style={{ color: a.last_fetch_status === 'error' ? 'var(--bad)' : undefined }}>{a.last_fetch_message}</span>}</>
                    : <span className="muted">{a.provider === 'manual' ? 'Sans objet' : 'Jamais'}</span>}
                </td>
                <td className="num">{fmtNum(a.rules)}</td>
                <td className="actions">
                  {a.provider !== 'manual' && <button className="btn small" disabled={busyId === a.id} onClick={() => fetchNow(a)}>{busyId === a.id ? 'Récupération…' : 'Récupérer maintenant'}</button>}
                  <button className="btn small" onClick={() => setEdit(a)}>Modifier</button>
                  <button className="btn small danger" onClick={() => remove(a)}>Supprimer</button>
                </td>
              </tr>))}</tbody>
          </table></div>
        ) : <Empty>Aucun compte fournisseur. Ajoutez-en un pour suivre les coûts réels.</Empty>}
      </Async>
      {edit && <AccountModal acc={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); r.reload(); }} />}
    </Card>
  );
}

function AccountModal({ acc, onClose, onSaved }: { acc: Account | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ provider: acc?.provider ?? 'openai', name: acc?.name ?? '', api_key: '' });
  const needsKey = f.provider !== 'manual';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => acc
      ? api.patch(`/api/admin/llm/accounts/${acc.id}`, { name: f.name.trim(), ...(f.api_key ? { api_key: f.api_key } : {}) })
      : api.post('/api/admin/llm/accounts', { provider: f.provider, name: f.name.trim(), ...(needsKey ? { api_key: f.api_key } : {}) }), acc ? 'Compte enregistré.' : 'Compte ajouté.');
    if (ok) onSaved();
  };
  return (
    <Modal title={acc ? `Modifier « ${acc.name} »` : 'Ajouter un compte fournisseur'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">Fournisseur
          <select value={f.provider} disabled={!!acc} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            {Object.entries(PROVIDERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex. : OpenAI agence" /></label>
        {needsKey && (
          <label className="field">Clé API
            <span className="help">{acc ? <>Actuelle : <span className="mono">{acc.api_key_hint}</span>. Laissez vide pour la conserver.</> : 'Chiffrée à l’enregistrement, jamais réaffichée.'}</span>
            <input type="password" autoComplete="new-password" required={!acc} minLength={10} value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} placeholder={acc ? 'Inchangée' : ''} />
          </label>
        )}
        <div className="ag-form-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={busy}>{acc ? 'Enregistrer' : 'Ajouter'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- attribution

interface Unattributed { account_id: string; provider: string; project: string | null; workspace: string | null; api_key_ref: string | null; model: string; cost_usd: number }

function Attribution({ clients }: { clients: ClientLite[] }) {
  const accounts = useApi<Account[]>('/api/admin/llm/accounts');
  const rules = useApi<any[]>('/api/admin/llm/rules');
  const un = useApi<Unattributed[]>('/api/admin/llm/unattributed');
  const { run, busy } = useAction();
  const { confirm, toast } = useUi();
  const apiAccounts = (accounts.data ?? []).filter((a) => a.provider !== 'manual');
  const accName = (id: string) => accounts.data?.find((a) => a.id === id)?.name ?? '—';
  const empty = { account_id: '', dimension: 'project', match_value: '', client_id: '', workflow_id: '' };
  const [f, setF] = useState(empty);
  const formRef = useRef<HTMLDivElement>(null);
  const wfs = useApi<{ id: string; name: string; display_name: string | null }[]>(f.client_id ? `/api/admin/workflows${qs({ client_id: f.client_id })}` : null);
  const account = f.account_id || apiAccounts[0]?.id || '';
  const reload = () => { rules.reload(); un.reload(); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ reattributed: number }>('/api/admin/llm/rules', { ...f, account_id: account, match_value: f.match_value.trim(), workflow_id: f.workflow_id || null }));
    if (r) { setF(empty); reload(); toast(`Règle enregistrée : ${fmtNum(r.reattributed)} ligne(s) attribuée(s).`); }
  };
  const prefill = (u: Unattributed) => {
    const [dimension, match_value] = u.api_key_ref ? ['api_key', u.api_key_ref] : u.project ? ['project', u.project] : u.workspace ? ['workspace', u.workspace] : ['model', u.model];
    setF({ ...empty, account_id: u.account_id, dimension, match_value });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const remove = async (x: any) => {
    const c = await confirm({ title: 'Supprimer la règle', danger: true, confirmLabel: 'Supprimer', message: <>Les coûts correspondant à « {x.match_value} » ne seront plus attribués à {x.client_name}.</> });
    if (c.ok && await run(() => api.del(`/api/admin/llm/rules/${x.id}`), 'Règle supprimée.')) reload();
  };
  return (
    <div className="stack">
      <div ref={formRef}>
        <Card title="Nouvelle règle d’attribution">
          {apiAccounts.length ? (
            <form className="form" onSubmit={save}>
              <p className="muted small" style={{ margin: 0 }}>Priorité d’application : clé API, puis projet, puis espace de travail, puis modèle. Les coûts déjà importés sont réattribués aussitôt.</p>
              <div className="form-grid">
                <label className="field">Compte<select value={account} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{apiAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <label className="field">Critère<select value={f.dimension} onChange={(e) => setF({ ...f, dimension: e.target.value })}>{Object.entries(DIMENSIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label className="field">Valeur exacte<input required value={f.match_value} onChange={(e) => setF({ ...f, match_value: e.target.value })} placeholder={f.dimension === 'model' ? 'gpt-4o-mini' : 'proj_…'} /></label>
                <label className="field">Client<ClientSelect value={f.client_id} onChange={(v) => setF({ ...f, client_id: v, workflow_id: '' })} clients={clients} allLabel="Choisir un client" /></label>
                <label className="field">Workflow (facultatif)
                  <select value={f.workflow_id} onChange={(e) => setF({ ...f, workflow_id: e.target.value })} disabled={!f.client_id}>
                    <option value="">Aucun en particulier</option>
                    {(wfs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.display_name || w.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="ag-form-foot"><button className="btn primary" disabled={busy || !f.client_id || !f.match_value.trim()}>Enregistrer la règle</button></div>
            </form>
          ) : <Empty>Ajoutez d’abord un compte fournisseur (onglet « Comptes fournisseurs »).</Empty>}
        </Card>
      </div>
      <Card title="Usage non attribué (90 jours)">
        <Async {...un}>
          {(rows) => rows.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Compte</th><th>Clé API</th><th>Projet</th><th>Espace</th><th>Modèle</th><th className="num">Coût</th><th /></tr></thead>
              <tbody>{rows.map((u, i) => (
                <tr key={i}>
                  <td>{accName(u.account_id)}<span className="ag-sub">{PROVIDER_SHORT[u.provider] ?? u.provider}</span></td>
                  <td className="mono small">{u.api_key_ref ?? '—'}</td><td className="mono small">{u.project ?? '—'}</td><td className="mono small">{u.workspace ?? '—'}</td>
                  <td className="mono small">{u.model}</td><td className="num">{fmtUsd(u.cost_usd)}</td>
                  <td className="actions"><button className="btn small" onClick={() => prefill(u)}>Attribuer</button></td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>Aucun usage non attribué.</Empty>}
        </Async>
      </Card>
      <Card title="Règles existantes">
        <Async {...rules}>
          {(rows) => rows.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Compte</th><th>Critère</th><th>Valeur</th><th>Client</th><th>Workflow</th><th /></tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={x.id}>
                  <td>{x.account_name}</td><td>{DIMENSIONS[x.dimension] ?? x.dimension}</td><td className="mono small">{x.match_value}</td>
                  <td><Link to={`/agence/clients/${x.client_id}`}>{x.client_name}</Link></td>
                  <td>{x.workflow_id ? <Link to={`/agence/workflows/${x.workflow_id}`}>{x.workflow_name}</Link> : <span className="muted">—</span>}</td>
                  <td className="actions"><button className="btn small danger" disabled={busy} onClick={() => remove(x)}>Supprimer</button></td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>Aucune règle d’attribution.</Empty>}
        </Async>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- saisie manuelle

function Manual({ clients }: { clients: ClientLite[] }) {
  const entries = useApi<any[]>('/api/admin/llm/entries?source=manual');
  const { run, busy } = useAction();
  const { confirm } = useUi();
  const empty = { day: iso(new Date()), provider: '', model: '', cost: '', client_id: '', workflow_id: '', note: '', input_tokens: '', output_tokens: '' };
  const [f, setF] = useState(empty);
  const wfs = useApi<{ id: string; name: string; display_name: string | null }[]>(f.client_id ? `/api/admin/workflows${qs({ client_id: f.client_id })}` : null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api.post('/api/admin/llm/manual', {
      day: f.day, provider: f.provider.trim(), model: f.model.trim(), cost_usd: toNum(f.cost) ?? 0, client_id: f.client_id || null, workflow_id: f.workflow_id || null,
      note: f.note.trim() || undefined, input_tokens: parseInt(f.input_tokens, 10) || undefined, output_tokens: parseInt(f.output_tokens, 10) || undefined,
    }), 'Coût enregistré.');
    if (ok) { setF({ ...empty, day: f.day, provider: f.provider, client_id: f.client_id }); entries.reload(); }
  };
  const remove = async (x: any) => {
    const c = await confirm({ title: 'Supprimer la saisie', danger: true, confirmLabel: 'Supprimer', message: <>Supprimer {fmtUsd(x.cost_usd)} du {fmtDate(x.day)} ({x.model}) ?</> });
    if (c.ok && await run(() => api.del(`/api/admin/llm/manual/${x.id}`), 'Saisie supprimée.')) entries.reload();
  };
  return (
    <div className="stack">
      <Card title="Ajouter un coût">
        <form className="form" onSubmit={save}>
          <p className="muted small" style={{ margin: 0 }}>Pour un fournisseur sans API de facturation (abonnement, facture reçue par e-mail…).</p>
          <div className="form-grid">
            <label className="field">Jour<input type="date" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
            <label className="field">Montant ($US)<input inputMode="decimal" required value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="0,00" /></label>
            <label className="field">Fournisseur<input required value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} placeholder="Mistral" /></label>
            <label className="field">Modèle<input required value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="mistral-large" /></label>
            <label className="field">Client<ClientSelect value={f.client_id} onChange={(v) => setF({ ...f, client_id: v, workflow_id: '' })} clients={clients} allLabel="Non attribué" /></label>
            <label className="field">Workflow (facultatif)
              <select value={f.workflow_id} onChange={(e) => setF({ ...f, workflow_id: e.target.value })} disabled={!f.client_id}>
                <option value="">Aucun en particulier</option>
                {(wfs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.display_name || w.name}</option>)}
              </select>
            </label>
            <label className="field">Jetons en entrée (facultatif)<input type="number" min={0} value={f.input_tokens} onChange={(e) => setF({ ...f, input_tokens: e.target.value })} /></label>
            <label className="field">Jetons en sortie (facultatif)<input type="number" min={0} value={f.output_tokens} onChange={(e) => setF({ ...f, output_tokens: e.target.value })} /></label>
          </div>
          <label className="field">Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} placeholder="Ex. : facture n° 2026-09" /></label>
          <div className="ag-form-foot"><button className="btn primary" disabled={busy || toNum(f.cost) == null}>Enregistrer</button></div>
        </form>
      </Card>
      <Card title="Saisies manuelles">
        <Async {...entries}>
          {(rows) => rows.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Jour</th><th>Fournisseur / modèle</th><th>Client</th><th>Workflow</th><th className="num">Coût</th><th>Note</th><th /></tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={x.id}>
                  <td className="nowrap">{fmtDate(x.day)}</td>
                  <td>{x.provider}<span className="ag-sub mono">{x.model}</span></td>
                  <td>{x.client_id ? <Link to={`/agence/clients/${x.client_id}`}>{x.client_name}</Link> : <span className="muted">Non attribué</span>}</td>
                  <td>{x.workflow_name ?? <span className="muted">—</span>}</td>
                  <td className="num">{fmtUsd(x.cost_usd)}</td>
                  <td className="small">{x.note ?? '—'}</td>
                  <td className="actions"><button className="btn small danger" disabled={busy} onClick={() => remove(x)}>Supprimer</button></td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>Aucune saisie manuelle.</Empty>}
        </Async>
      </Card>
    </div>
  );
}
