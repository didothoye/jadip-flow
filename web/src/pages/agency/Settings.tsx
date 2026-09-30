import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { Async, Badge, Card, Empty, Modal, PageHead, Switch, useAction, useUi } from '../../components/ui';
import { Ago, ClientSelect, CopyField, Tabs, useClientList, useTab } from './shared';

const TABS = ['general', 'equipe', 'webhooks', 'taches'] as const;
type Tab = (typeof TABS)[number];

export default function Settings() {
  useTitle('Paramètres');
  const [tab, setTab] = useTab<Tab>(TABS, 'general');
  return (
    <div className="stack">
      <PageHead title="Paramètres" sub="Réglages de la plateforme, équipe de l’agence et intégrations." />
      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[['general', 'Général'], ['equipe', 'Équipe'], ['webhooks', 'Webhooks'], ['taches', 'Tâches planifiées']]} />
        {tab === 'general' && <General />}
        {tab === 'equipe' && <Team />}
        {tab === 'webhooks' && <Webhooks />}
        {tab === 'taches' && <Jobs />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- général

interface AppSettings {
  quietHours: { enabled: boolean; start: string; end: string };
  atRisk: { inactivityDays: number; failureRatePct: number; minExecutions: number };
  sync: { maxInitialExecutions: number; errorDetailsPerSync: number };
  reports: { autoSendDay: number };
  notifyAdminOnClientAction: boolean | unknown;
  channels: { telegram: boolean; email: boolean; adminEmail: string | null };
  timezone: string;
}

function General() {
  const r = useApi<AppSettings>('/api/admin/settings');
  return <Async {...r}>{(s) => <GeneralForm s={s} onSaved={r.reload} />}</Async>;
}

function GeneralForm({ s, onSaved }: { s: AppSettings; onSaved: () => void }) {
  const { run, busy } = useAction();
  const { toast } = useUi();
  const toForm = (x: AppSettings) => ({
    qEnabled: x.quietHours.enabled, qStart: x.quietHours.start, qEnd: x.quietHours.end,
    inactivityDays: String(x.atRisk.inactivityDays), failureRatePct: String(x.atRisk.failureRatePct), minExecutions: String(x.atRisk.minExecutions),
    maxInitial: String(x.sync.maxInitialExecutions), errorDetails: String(x.sync.errorDetailsPerSync), autoSendDay: String(x.reports.autoSendDay),
    notify: x.notifyAdminOnClientAction === true,
  });
  const [f, setF] = useState(() => toForm(s));
  useEffect(() => setF(toForm(s)), [s]);
  const [testing, setTesting] = useState<string | null>(null);
  const n = (v: string) => Number(v.replace(',', '.'));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api.patch('/api/admin/settings', {
      quietHours: { enabled: f.qEnabled, start: f.qStart, end: f.qEnd },
      atRisk: { inactivityDays: n(f.inactivityDays), failureRatePct: n(f.failureRatePct), minExecutions: n(f.minExecutions) },
      sync: { maxInitialExecutions: n(f.maxInitial), errorDetailsPerSync: n(f.errorDetails) },
      reports: { autoSendDay: n(f.autoSendDay) },
      notifyAdminOnClientAction: f.notify,
    }), 'Paramètres enregistrés.');
    if (ok) onSaved();
  };
  const test = async (channel: 'telegram' | 'email') => {
    setTesting(channel);
    try { const r = await api.post<{ ok: boolean; message: string }>('/api/admin/settings/test-channel', { channel }); toast(r.message, r.ok ? 'ok' : 'error'); }
    catch (e: any) { toast(e.message, 'error'); } finally { setTesting(null); }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="ag-2-1">
      <Card title="Réglages généraux">
        <form className="form" onSubmit={save}>
          <div>
            <h3>Heures calmes</h3>
            <p className="muted small">Les notifications Telegram et e-mail non critiques sont retenues pendant cette plage, puis envoyées à la fin. Fuseau horaire : <strong>{s.timezone}</strong>.</p>
            <label className="check"><input type="checkbox" checked={f.qEnabled} onChange={(e) => setF({ ...f, qEnabled: e.target.checked })} />Activer les heures calmes</label>
            <div className="form-grid" style={{ marginTop: '.6rem' }}>
              <label className="field">Début<input type="time" required value={f.qStart} onChange={set('qStart')} disabled={!f.qEnabled} /></label>
              <label className="field">Fin<input type="time" required value={f.qEnd} onChange={set('qEnd')} disabled={!f.qEnabled} /></label>
            </div>
          </div>
          <div className="ag-form-section">
            <h3>Détection des clients à risque</h3>
            <div className="form-grid">
              <label className="field">Inactivité par défaut (jours)<span className="help">Modifiable client par client.</span><input type="number" min={1} value={f.inactivityDays} onChange={set('inactivityDays')} /></label>
              <label className="field">Taux d’échec sur 7 jours (%)<span className="help">Au-delà, le client est signalé.</span><input type="number" min={0} max={100} value={f.failureRatePct} onChange={set('failureRatePct')} /></label>
              <label className="field">Exécutions minimales<span className="help">Pour que le taux d’échec soit pris en compte.</span><input type="number" min={1} value={f.minExecutions} onChange={set('minExecutions')} /></label>
            </div>
          </div>
          <div className="ag-form-section">
            <h3>Synchronisation</h3>
            <div className="form-grid">
              <label className="field">Historique importé au premier passage<span className="help">Nombre maximal d’exécutions par instance.</span><input type="number" min={100} max={1000000} value={f.maxInitial} onChange={set('maxInitial')} /></label>
              <label className="field">Détails d’erreur récupérés par passage<input type="number" min={0} max={1000} value={f.errorDetails} onChange={set('errorDetails')} /></label>
            </div>
          </div>
          <div className="ag-form-section">
            <h3>Rapports et notifications</h3>
            <div className="form-grid">
              <label className="field">Jour d’envoi automatique des rapports<span className="help">Jour du mois (1 à 28) où le rapport du mois écoulé est envoyé.</span><input type="number" min={1} max={28} value={f.autoSendDay} onChange={set('autoSendDay')} /></label>
            </div>
            <label className="check" style={{ marginTop: '.6rem' }}><input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /><span>Me prévenir quand un client active, désactive ou relance une automatisation</span></label>
          </div>
          <div className="ag-form-foot">
            <button type="button" className="btn" onClick={() => setF(toForm(s))} disabled={busy}>Annuler les modifications</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </form>
      </Card>
      <Card title="Canaux de notification">
        <ul className="ag-list">
          <li>
            <span className="main-col"><span className="title">Telegram</span><span className="meta" style={{ display: 'block' }}>{s.channels.telegram ? 'Robot et discussion de l’agence configurés.' : 'Non configuré (variables TELEGRAM_BOT_TOKEN et TELEGRAM_ADMIN_CHAT_ID).'}</span></span>
            <span className="row" style={{ gap: '.4rem' }}>{s.channels.telegram ? <Badge tone="good">Configuré</Badge> : <Badge>Inactif</Badge>}
              <button className="btn small" disabled={!s.channels.telegram || testing === 'telegram'} onClick={() => test('telegram')}>Envoyer un test</button></span>
          </li>
          <li>
            <span className="main-col"><span className="title">E-mail</span><span className="meta" style={{ display: 'block' }}>{s.channels.email ? <>Serveur SMTP configuré{s.channels.adminEmail ? <> · envoi à {s.channels.adminEmail}</> : null}.</> : 'Non configuré (variables SMTP_*).'}</span></span>
            <span className="row" style={{ gap: '.4rem' }}>{s.channels.email ? <Badge tone="good">Configuré</Badge> : <Badge>Inactif</Badge>}
              <button className="btn small" disabled={!s.channels.email || testing === 'email'} onClick={() => test('email')}>Envoyer un test</button></span>
          </li>
          <li><span className="main-col"><span className="title">Application</span><span className="meta" style={{ display: 'block' }}>Alertes visibles dans Jadip Flow.</span></span><Badge tone="good">Toujours actif</Badge></li>
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>Vos préférences personnelles (Telegram, e-mail) se règlent dans <Link to="/agence/compte">Mon compte</Link>.</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- équipe

interface UserRow { id: string; email: string; name: string; role: string; client_id: string | null; client_name: string | null; totp_enabled: boolean; last_login_at: string | null; disabled_at: string | null; activated: boolean }

function Team() {
  const { user } = useAuth();
  const r = useApi<UserRow[]>('/api/admin/users');
  const { run, busy } = useAction();
  const { confirm } = useUi();
  const [f, setF] = useState({ email: '', name: '' });
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const u = await run(() => api.post<{ email: string; invite_link: string }>('/api/admin/users', { email: f.email.trim(), name: f.name.trim() }), 'Invitation envoyée.');
    if (u) { setF({ email: '', name: '' }); setLink({ email: u.email, url: u.invite_link }); r.reload(); }
  };
  const resend = async (u: UserRow) => {
    const x = await run(() => api.post<{ invite_link: string }>(`/api/admin/users/${u.id}/invite`), 'Invitation renvoyée par e-mail.');
    if (x) setLink({ email: u.email, url: x.invite_link });
  };
  const toggle = async (u: UserRow) => {
    const disable = !u.disabled_at;
    const c = await confirm({ title: disable ? 'Désactiver le compte' : 'Réactiver le compte', danger: disable, confirmLabel: disable ? 'Désactiver' : 'Réactiver',
      message: disable ? <>{u.name} ne pourra plus se connecter ; ses sessions et accès en cours sont fermés.</> : <>{u.name} pourra de nouveau se connecter.</> });
    if (c.ok && await run(() => api.patch(`/api/admin/users/${u.id}`, { disabled: disable }), disable ? 'Compte désactivé.' : 'Compte réactivé.')) r.reload();
  };
  const resetTotp = async (u: UserRow) => {
    const c = await confirm({ title: 'Réinitialiser la double authentification', danger: true, confirmLabel: 'Réinitialiser', message: <>{u.name} pourra se connecter avec son seul mot de passe.</> });
    if (c.ok && await run(() => api.patch(`/api/admin/users/${u.id}`, { reset_totp: true }), 'Double authentification réinitialisée.')) r.reload();
  };
  return (
    <div className="stack">
      <Card title="Membres de l’agence">
        <Async {...r}>
          {(rows) => {
            const admins = rows.filter((u) => u.role === 'admin');
            const clientsCount = rows.length - admins.length;
            return (
              <>
                {admins.length ? (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th>Membre</th><th>Statut</th><th>Double authentification</th><th>Dernière connexion</th><th className="right">Actions</th></tr></thead>
                    <tbody>{admins.map((u) => (
                      <tr key={u.id} className={u.disabled_at ? 'muted-row' : ''}>
                        <td><strong>{u.name}</strong>{u.id === user?.id && <> <Badge tone="info">Vous</Badge></>}<span className="ag-sub">{u.email}</span></td>
                        <td>{u.disabled_at ? <Badge tone="bad">Désactivé</Badge> : u.activated ? <Badge tone="good">Actif</Badge> : <Badge tone="warn">Invitation en attente</Badge>}</td>
                        <td>{u.totp_enabled ? <Badge tone="good">Activée</Badge> : <Badge tone="warn">Non activée</Badge>}</td>
                        <td><Ago at={u.last_login_at} /></td>
                        <td className="actions">
                          {!u.activated && !u.disabled_at && <button className="btn small" disabled={busy} onClick={() => resend(u)}>Renvoyer l’invitation</button>}
                          {u.totp_enabled && u.id !== user?.id && <button className="btn small" disabled={busy} onClick={() => resetTotp(u)}>Réinitialiser la double authentification</button>}
                          {u.id !== user?.id && <button className={`btn small ${u.disabled_at ? '' : 'danger'}`} disabled={busy} onClick={() => toggle(u)}>{u.disabled_at ? 'Réactiver' : 'Désactiver'}</button>}
                        </td>
                      </tr>))}</tbody>
                  </table></div>
                ) : <Empty>Aucun membre.</Empty>}
                <p className="muted small" style={{ marginBottom: 0 }}>{fmtNum(clientsCount)} compte(s) client, gérés depuis la fiche de chaque <Link to="/agence/clients">client</Link>.</p>
              </>
            );
          }}
        </Async>
      </Card>
      <Card title="Inviter un membre de l’agence">
        <form className="form" onSubmit={invite}>
          <div className="alert warn small">Un membre de l’agence a accès à tous les clients, à toutes les instances et à tous les réglages.</div>
          <div className="form-grid">
            <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">E-mail<input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          </div>
          <div className="ag-form-foot"><button className="btn primary" disabled={busy}>Inviter</button></div>
        </form>
      </Card>
      {link && (
        <Modal title="Lien d’activation" onClose={() => setLink(null)} actions={<button className="btn primary" onClick={() => setLink(null)}>Fermer</button>}>
          <p className="small">Un e-mail a été envoyé à <strong>{link.email}</strong>. Vous pouvez aussi lui transmettre ce lien (valable 7 jours) :</p>
          <CopyField value={link.url} label="Lien d’activation" />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- webhooks

const EVENT_LABELS: Record<string, string> = {
  'execution.failed': 'Exécution en échec', 'workflow.activated': 'Workflow activé', 'workflow.deactivated': 'Workflow désactivé',
  'workflow.deactivated_by_client': 'Workflow désactivé par le client', 'ticket.created': 'Demande créée', 'ticket.updated': 'Demande mise à jour', 'alert.opened': 'Alerte ouverte',
};
interface Hook { id: string; name: string; url: string; events: string[]; client_id: string | null; client_name: string | null; enabled: boolean; created_at: string; failed: number; last_delivered_at: string | null }

function Webhooks() {
  const r = useApi<{ hooks: Hook[]; events: string[] }>('/api/admin/webhooks');
  const { run } = useAction();
  const { confirm } = useUi();
  const [edit, setEdit] = useState<Hook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = async (h: Hook, on: boolean) => { if (await run(() => api.patch(`/api/admin/webhooks/${h.id}`, { enabled: on }), on ? 'Webhook activé.' : 'Webhook désactivé.')) r.reload(); };
  const remove = async (h: Hook) => {
    const c = await confirm({ title: 'Supprimer le webhook', danger: true, confirmLabel: 'Supprimer', message: <>« {h.name} » ne recevra plus aucun événement.</> });
    if (c.ok && await run(() => api.del(`/api/admin/webhooks/${h.id}`), 'Webhook supprimé.')) r.reload();
  };
  return (
    <Card title="Webhooks sortants" actions={<button className="btn primary" onClick={() => setEdit('new')}>Nouveau webhook</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Jadip Flow envoie une requête POST signée (en-tête x-jadip-signature, HMAC SHA-256) à chaque événement choisi. Les échecs sont réessayés automatiquement.</p>
      <Async {...r}>
        {(d) => d.hooks.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Actif</th><th>Webhook</th><th>Événements</th><th>Portée</th><th>Dernière livraison</th><th className="right">Actions</th></tr></thead>
            <tbody>{d.hooks.map((h) => (
              <Fragment key={h.id}>
                <tr className={h.enabled ? '' : 'muted-row'}>
                  <td><Switch checked={h.enabled} onChange={(v) => toggle(h, v)} label={`${h.enabled ? 'Désactiver' : 'Activer'} « ${h.name} »`} /></td>
                  <td><strong>{h.name}</strong><span className="ag-sub mono" style={{ wordBreak: 'break-all' }}>{h.url}</span></td>
                  <td><span className="ag-tags">{h.events.map((e) => <Badge key={e}>{EVENT_LABELS[e] ?? e}</Badge>)}</span></td>
                  <td className="small">{h.client_name ?? 'Tous les clients'}</td>
                  <td className="small"><Ago at={h.last_delivered_at} />{h.failed > 0 && <span className="ag-sub" style={{ color: 'var(--bad)' }}>{fmtNum(h.failed)} échec(s)</span>}</td>
                  <td className="actions">
                    <button className="btn small" onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id}>{open === h.id ? 'Masquer les livraisons' : 'Livraisons'}</button>
                    <button className="btn small" onClick={() => setEdit(h)}>Modifier</button>
                    <button className="btn small danger" onClick={() => remove(h)}>Supprimer</button>
                  </td>
                </tr>
                {open === h.id && <tr><td colSpan={6} style={{ background: 'var(--surface-2)' }}><Deliveries id={h.id} /></td></tr>}
              </Fragment>
            ))}</tbody>
          </table></div>
        ) : <Empty>Aucun webhook.</Empty>}
      </Async>
      {edit && r.data && <HookModal hook={edit === 'new' ? null : edit} events={r.data.events} onClose={() => setEdit(null)}
        onSaved={(s) => { setEdit(null); r.reload(); if (s) setSecret(s); }} />}
      {secret && (
        <Modal title="Secret de signature" onClose={() => setSecret(null)} actions={<button className="btn primary" onClick={() => setSecret(null)}>J’ai copié le secret</button>}>
          <div className="alert warn small" style={{ marginBottom: '.8rem' }}>Conservez ce secret maintenant : il ne sera plus jamais affiché.</div>
          <CopyField value={secret} label="Secret" />
        </Modal>
      )}
    </Card>
  );
}

function Deliveries({ id }: { id: string }) {
  const r = useApi<any[]>(`/api/admin/webhooks/${id}/deliveries`);
  return (
    <Async {...r}>
      {(rows) => rows.length ? (
        <table className="table small">
          <thead><tr><th>Date</th><th>Événement</th><th>Statut</th><th className="num">Tentatives</th><th className="num">Code HTTP</th><th>Erreur</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.id}>
              <td className="nowrap">{fmtDateTime(x.created_at)}</td>
              <td>{EVENT_LABELS[x.event] ?? x.event}</td>
              <td>{x.status === 'delivered' ? <Badge tone="good">Livrée</Badge> : x.status === 'failed' ? <Badge tone="bad">Échec</Badge> : <Badge tone="info">En attente</Badge>}</td>
              <td className="num">{x.attempts}</td>
              <td className="num">{x.response_code ?? '—'}</td>
              <td>{x.last_error ?? '—'}</td>
            </tr>))}</tbody>
        </table>
      ) : <Empty>Aucune livraison.</Empty>}
    </Async>
  );
}

function HookModal({ hook, events, onClose, onSaved }: { hook: Hook | null; events: string[]; onClose: () => void; onSaved: (secret?: string) => void }) {
  const { run, busy } = useAction();
  const { clients } = useClientList();
  const [f, setF] = useState({ name: hook?.name ?? '', url: hook?.url ?? '', events: hook?.events ?? ['execution.failed'], client_id: hook?.client_id ?? '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (hook) {
      if (await run(() => api.patch(`/api/admin/webhooks/${hook.id}`, { name: f.name.trim(), events: f.events }), 'Webhook enregistré.')) onSaved();
    } else {
      const r = await run(() => api.post<{ secret: string }>('/api/admin/webhooks', { name: f.name.trim(), url: f.url.trim(), events: f.events, client_id: f.client_id || null }), 'Webhook créé.');
      if (r) onSaved(r.secret);
    }
  };
  return (
    <Modal title={hook ? `Modifier « ${hook.name} »` : 'Nouveau webhook'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">URL de destination<span className="help">{hook ? 'Non modifiable : créez un nouveau webhook pour changer d’adresse.' : 'Adresse https:// uniquement.'}</span>
          <input required type="url" pattern="https://.*" value={f.url} disabled={!!hook} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://exemple.com/webhooks/jadip" />
        </label>
        {!hook && <label className="field">Portée<ClientSelect value={f.client_id} onChange={(v) => setF({ ...f, client_id: v })} clients={clients} /></label>}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 500, marginBottom: '.35rem' }}>Événements</legend>
          <div className="ag-checks">
            {events.map((ev) => (
              <label key={ev} className="check"><input type="checkbox" checked={f.events.includes(ev)}
                onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev] : f.events.filter((x) => x !== ev) })} />
                <span>{EVENT_LABELS[ev] ?? ev}<span className="ag-sub mono">{ev}</span></span></label>
            ))}
          </div>
        </fieldset>
        <div className="ag-form-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={busy || !f.events.length}>{hook ? 'Enregistrer' : 'Créer le webhook'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- tâches planifiées

const JOB_LABELS: Record<string, [string, string]> = {
  sync: ['Synchronisation des instances', 'Chaque minute (selon l’intervalle de chaque instance)'],
  alerts: ['Évaluation des alertes', 'Toutes les 5 minutes'],
  'alert-notifications': ['Notifications d’alertes', 'Chaque minute'],
  outbox: ['Envoi des messages (e-mail, Telegram)', 'Toutes les 30 secondes'],
  webhooks: ['Livraison des webhooks', 'Toutes les 30 secondes'],
  'resume-paused': ['Reprise des workflows en pause', 'Chaque minute'],
  purge: ['Purge des données anciennes', 'Toutes les 6 heures'],
  'llm-usage': ['Récupération des coûts IA', 'Toutes les 6 heures'],
  'monthly-reports': ['Rapports mensuels', 'Toutes les heures (envoi le jour choisi)'],
};

function Jobs() {
  const r = useApi<{ jobs: any[]; outbox: { status: string; channel: string; n: number }[] }>('/api/admin/jobs');
  return (
    <div className="stack">
      <Card title="Tâches planifiées" actions={<button className="btn small" onClick={r.reload}>Actualiser</button>}>
        <Async {...r}>
          {(d) => d.jobs.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Tâche</th><th>Dernier lancement</th><th>Durée</th><th>Statut</th><th>Résultat</th></tr></thead>
              <tbody>{d.jobs.map((j) => {
                const dur = j.last_finished_at && j.last_started_at ? new Date(j.last_finished_at).getTime() - new Date(j.last_started_at).getTime() : null;
                return (
                  <tr key={j.name}>
                    <td><strong>{JOB_LABELS[j.name]?.[0] ?? j.name}</strong><span className="ag-sub">{JOB_LABELS[j.name]?.[1] ?? ''} · <span className="mono">{j.name}</span></span></td>
                    <td><Ago at={j.last_started_at} /></td>
                    <td className="small">{dur != null && dur >= 0 ? `${fmtNum(dur)} ms` : '—'}</td>
                    <td>{j.last_status === 'ok' ? <Badge tone="good">Réussie</Badge> : j.last_status === 'error' ? <Badge tone="bad">Erreur</Badge> : <Badge>{j.last_status ?? 'Jamais lancée'}</Badge>}</td>
                    <td><span className="mono small ag-clamp" title={j.last_message ?? ''}>{j.last_message ?? '—'}</span></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          ) : <Empty>Aucune tâche exécutée pour l’instant.</Empty>}
        </Async>
      </Card>
      <Card title="Messages sortants (7 derniers jours)">
        <Async {...r}>
          {(d) => d.outbox.length ? (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Canal</th><th>Statut</th><th className="num">Messages</th></tr></thead>
              <tbody>{d.outbox.map((o) => (
                <tr key={`${o.channel}|${o.status}`}>
                  <td>{o.channel === 'email' ? 'E-mail' : o.channel === 'telegram' ? 'Telegram' : o.channel}</td>
                  <td>{o.status === 'sent' ? <Badge tone="good">Envoyés</Badge> : o.status === 'failed' ? <Badge tone="bad">Échecs</Badge> : <Badge tone="info">En attente</Badge>}</td>
                  <td className="num">{fmtNum(o.n)}</td>
                </tr>))}</tbody>
            </table></div>
          ) : <Empty>Aucun message sur 7 jours.</Empty>}
        </Async>
      </Card>
    </div>
  );
}
