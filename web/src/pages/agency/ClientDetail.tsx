import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDate, fmtDateTime, fmtDuration, fmtNum, fmtUsd, fromNow } from '../../lib/format';
import { Async, Badge, Card, Empty, Modal, PageHead, Stat, useAction, useUi } from '../../components/ui';
import { CostBars, DailyBars, ShareBar } from '../../components/charts';
import {
  ActionLogTable, Ago, AlertStatusBadge, CategoryCounts, CopyField, ErrorTable, Initials, Rate, RiskBadge, SeverityBadge, Tabs, toNum, numStr, useTab, WorkflowSwitch,
  type ActionRow, type ErrorRow,
} from './shared';
import type { ClientSummary } from './Clients';

interface ClientRow {
  id: string; code: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; notes: string | null;
  logo_path: string | null; is_internal: boolean; can_toggle: boolean; can_retry: boolean; show_costs: boolean; show_reports: boolean;
  report_email_enabled: boolean; report_emails: string[]; monthly_budget_usd: number | null; monthly_fee_usd: number | null; inactivity_days: number;
  archived_at: string | null; updated_at?: string;
}
interface UserRow { id: string; email: string; name: string; totp_enabled: boolean; last_login_at: string | null; disabled_at: string | null; created_at: string; activated: boolean }
interface Detail {
  client: ClientRow; summary: ClientSummary; workflows: any[]; series: { day: string; total: number; success: number; failed: number }[];
  errors: ErrorRow[]; categories: { category: string; n: number }[]; users: UserRow[]; alerts: any[]; actions: ActionRow[];
  costs: { day: string; provider: string; model: string; cost_usd: number }[];
}

const TABS = ['workflows', 'activite', 'utilisateurs', 'parametres', 'alertes', 'couts'] as const;
type Tab = (typeof TABS)[number];

export default function ClientDetail() {
  const { id } = useParams();
  const r = useApi<Detail>(`/api/admin/clients/${id}`);
  const [tab, setTab] = useTab<Tab>(TABS, 'workflows');
  useTitle(r.data?.client.name ?? 'Client');
  return (
    <div className="stack">
      <Async {...r}>
        {(d) => {
          const c = d.client;
          const s = d.summary;
          return (
            <>
              <PageHead crumb={<Link to="/agence/clients">Clients</Link>}
                title={<span className="ag-head">
                  {c.logo_path ? <img className="ag-logo" src={`/api/clients/${c.id}/logo?v=${encodeURIComponent(c.updated_at ?? '')}`} alt="" /> : <Initials name={c.name} />}
                  <span>{c.name}</span>
                </span>}
                sub={<span className="row" style={{ gap: '.4rem' }}>
                  <span className="mono">client:{c.code}</span>
                  {c.is_internal && <Badge>Interne</Badge>}
                  {c.archived_at && <Badge tone="warn">Archivé le {fmtDate(c.archived_at)}</Badge>}
                  <RiskBadge risks={s.risks} />
                  {c.contact_name && <span>{c.contact_name}{c.contact_email ? <> — <a href={`mailto:${c.contact_email}`}>{c.contact_email}</a></> : null}</span>}
                </span>} />
              {s.risks.length > 0 && <div className="alert error">{s.risks.join(' · ')}</div>}
              <div className="ag-kpis">
                <Stat label="Workflows actifs" value={`${fmtNum(s.workflows_active)} / ${fmtNum(s.workflows)}`} />
                <Stat label="Exécutions 30 j" value={fmtNum(s.exec_30d)} hint={`${fmtNum(s.fail_30d)} échec(s)`} />
                <Stat label="Taux de réussite 30 j" value={<Rate value={s.success_rate_30d} />} />
                <Stat label="Dernière exécution" value={<span style={{ fontSize: '1.1rem' }}>{fromNow(s.last_execution_at)}</span>} hint={fmtDateTime(s.last_execution_at)} />
                <Stat label="Temps gagné ce mois" value={fmtDuration(s.minutes_saved_month)} />
                <Stat label="Coût IA du mois" value={fmtUsd(s.llm_month_usd)} tone={s.monthly_budget_usd && s.llm_month_usd >= s.monthly_budget_usd ? 'bad' : undefined}
                  hint={s.monthly_budget_usd ? `Budget : ${fmtUsd(s.monthly_budget_usd)}` : 'Sans budget'} />
                <Stat label="Alertes ouvertes" value={fmtNum(s.alerts_open)} tone={s.alerts_open ? 'bad' : undefined} hint={`${fmtNum(s.tickets_open)} demande(s) en cours`} />
              </div>
              <div>
                <Tabs<Tab> value={tab} onChange={setTab} tabs={[
                  ['workflows', `Workflows (${d.workflows.length})`], ['activite', 'Activité'], ['utilisateurs', `Utilisateurs (${d.users.length})`],
                  ['parametres', 'Paramètres'], ['alertes', 'Alertes et journal'], ['couts', 'Coûts'],
                ]} />
                {tab === 'workflows' && <WorkflowsTab d={d} reload={r.reload} />}
                {tab === 'activite' && <ActivityTab d={d} reload={r.reload} />}
                {tab === 'utilisateurs' && <UsersTab d={d} reload={r.reload} />}
                {tab === 'parametres' && <SettingsTab c={c} reload={r.reload} />}
                {tab === 'alertes' && <AlertsTab d={d} reload={r.reload} />}
                {tab === 'couts' && <CostsTab d={d} />}
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}

function WorkflowsTab({ d, reload }: { d: Detail; reload: () => void }) {
  if (!d.workflows.length) return <Card><Empty>Aucun workflow rattaché. Ajoutez l’étiquette <span className="mono">client:{d.client.code}</span> dans n8n ou rattachez-en un depuis sa fiche.</Empty></Card>;
  return (
    <Card>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Workflow</th><th>État</th><th className="num">Exéc. 30 j</th><th className="num">Réussite</th><th>Dernière exécution</th><th className="num" title="Erreurs non traitées sur 7 jours">Erreurs 7 j</th><th className="num" title="Temps gagné ce mois">Temps gagné</th><th>Portail</th></tr></thead>
          <tbody>
            {d.workflows.map((w) => (
              <tr key={w.id}>
                <td className="ag-name"><Link to={`/agence/workflows/${w.id}`} style={{ fontWeight: 600 }}>{w.display_name || w.name}</Link>{w.display_name && <span className="ag-sub">{w.name}</span>}</td>
                <td><WorkflowSwitch wf={w} onChanged={reload} withLabel /></td>
                <td className="num">{fmtNum(w.exec_30d)}</td>
                <td className="num"><Rate value={w.success_rate_30d} /></td>
                <td><Ago at={w.last_execution_at} /></td>
                <td className="num">{w.unhandled_errors_7d ? <Badge tone="bad">{w.unhandled_errors_7d}</Badge> : <span className="muted">0</span>}</td>
                <td className="num">{fmtDuration(w.minutes_saved_month)}</td>
                <td>{w.client_visible ? <Badge tone="info">Visible</Badge> : <Badge>Masqué</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ActivityTab({ d, reload }: { d: Detail; reload: () => void }) {
  return (
    <div className="stack">
      <div className="ag-2-1">
        <Card title="Exécutions des 30 derniers jours"><DailyBars data={d.series} /></Card>
        <Card title="Erreurs par catégorie (30 j)"><CategoryCounts rows={d.categories} /></Card>
      </div>
      <Card title="Dernières erreurs" actions={<Link to={`/agence/erreurs?client=${d.client.id}`} className="small">Toutes les erreurs du client</Link>}>
        <ErrorTable rows={d.errors} onChanged={reload} showClient={false} empty="Aucune erreur récente." />
      </Card>
    </div>
  );
}

function UsersTab({ d, reload }: { d: Detail; reload: () => void }) {
  const { run, busy } = useAction();
  const { confirm } = useUi();
  const [f, setF] = useState({ email: '', name: '' });
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const u = await run(() => api.post<{ email: string; invite_link: string | null }>(`/api/admin/clients/${d.client.id}/users`, { email: f.email.trim(), name: f.name.trim() }), 'Invitation envoyée.');
    if (u) { setF({ email: '', name: '' }); if (u.invite_link) setLink({ email: u.email, url: u.invite_link }); reload(); }
  };
  const resend = async (u: UserRow) => {
    const r = await run(() => api.post<{ invite_link: string }>(`/api/admin/users/${u.id}/invite`), 'Invitation renvoyée par e-mail.');
    if (r) setLink({ email: u.email, url: r.invite_link });
  };
  const toggle = async (u: UserRow) => {
    const disable = !u.disabled_at;
    const ok = await confirm({ title: disable ? 'Désactiver le compte' : 'Réactiver le compte', danger: disable, confirmLabel: disable ? 'Désactiver' : 'Réactiver',
      message: disable ? <>{u.name} ne pourra plus se connecter et ses sessions en cours seront fermées.</> : <>{u.name} pourra de nouveau se connecter.</> });
    if (ok.ok && await run(() => api.patch(`/api/admin/users/${u.id}`, { disabled: disable }), disable ? 'Compte désactivé.' : 'Compte réactivé.')) reload();
  };
  const resetTotp = async (u: UserRow) => {
    const ok = await confirm({ title: 'Réinitialiser la double authentification', danger: true, confirmLabel: 'Réinitialiser',
      message: <>{u.name} pourra se connecter avec son seul mot de passe, puis réactiver la double authentification depuis son compte.</> });
    if (ok.ok && await run(() => api.patch(`/api/admin/users/${u.id}`, { reset_totp: true }), 'Double authentification réinitialisée.')) reload();
  };
  return (
    <div className="stack">
      <Card title="Comptes du client">
        {d.users.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Utilisateur</th><th>Statut</th><th>Double authentification</th><th>Dernière connexion</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {d.users.map((u) => (
                  <tr key={u.id} className={u.disabled_at ? 'muted-row' : ''}>
                    <td><strong>{u.name}</strong><span className="ag-sub">{u.email}</span></td>
                    <td>{u.disabled_at ? <Badge tone="bad">Désactivé</Badge> : u.activated ? <Badge tone="good">Actif</Badge> : <Badge tone="warn">Invitation en attente</Badge>}</td>
                    <td>{u.totp_enabled ? <Badge tone="good">Activée</Badge> : <span className="muted">Non</span>}</td>
                    <td><Ago at={u.last_login_at} /></td>
                    <td className="actions">
                      {!u.activated && !u.disabled_at && <button className="btn small" disabled={busy} onClick={() => resend(u)}>Renvoyer l’invitation</button>}
                      {u.totp_enabled && <button className="btn small" disabled={busy} onClick={() => resetTotp(u)}>Réinitialiser la double authentification</button>}
                      <button className={`btn small ${u.disabled_at ? '' : 'danger'}`} disabled={busy} onClick={() => toggle(u)}>{u.disabled_at ? 'Réactiver' : 'Désactiver'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Aucun compte pour ce client.</Empty>}
      </Card>
      <Card title="Inviter un utilisateur">
        <form className="form" onSubmit={invite}>
          <p className="muted small" style={{ margin: 0 }}>La personne reçoit un e-mail avec un lien d’activation valable 7 jours. Elle ne verra que les automatisations de {d.client.name}.</p>
          <div className="form-grid">
            <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">E-mail<input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          </div>
          <div className="ag-form-foot"><button className="btn primary" disabled={busy}>Inviter</button></div>
        </form>
      </Card>
      {link && (
        <Modal title="Lien d’activation" onClose={() => setLink(null)} actions={<button className="btn primary" onClick={() => setLink(null)}>Fermer</button>}>
          <p className="small">Un e-mail a été envoyé à <strong>{link.email}</strong>. Vous pouvez aussi lui transmettre ce lien directement (valable 7 jours) :</p>
          <CopyField value={link.url} label="Lien d’activation" />
        </Modal>
      )}
    </div>
  );
}

function SettingsTab({ c, reload }: { c: ClientRow; reload: () => void }) {
  const { run, busy } = useAction();
  const { confirm, toast } = useUi();
  const init = useMemo(() => ({
    name: c.name, contact_name: c.contact_name ?? '', contact_email: c.contact_email ?? '', contact_phone: c.contact_phone ?? '', notes: c.notes ?? '',
    is_internal: c.is_internal, can_toggle: c.can_toggle, can_retry: c.can_retry, show_costs: c.show_costs, show_reports: c.show_reports,
    report_email_enabled: c.report_email_enabled, report_emails: (c.report_emails ?? []).join(', '),
    monthly_budget_usd: numStr(c.monthly_budget_usd), monthly_fee_usd: numStr(c.monthly_fee_usd), inactivity_days: String(c.inactivity_days ?? 3),
  }), [c]);
  const [f, setF] = useState(init);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const txt = (k: keyof typeof f) => ({ value: f[k] as string, onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const chk = (k: keyof typeof f) => ({ checked: f[k] as boolean, onChange: (e: { target: { checked: boolean } }) => setF({ ...f, [k]: e.target.checked }) });
  const emails = f.report_emails.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const inact = parseInt(f.inactivity_days, 10);
    const ok = await run(() => api.patch(`/api/admin/clients/${c.id}`, {
      name: f.name.trim(), contact_name: f.contact_name.trim() || null, contact_email: f.contact_email.trim() || null, contact_phone: f.contact_phone.trim() || null,
      notes: f.notes.trim() || null, is_internal: f.is_internal, can_toggle: f.can_toggle, can_retry: f.can_retry, show_costs: f.show_costs, show_reports: f.show_reports,
      report_email_enabled: f.report_email_enabled, report_emails: emails,
      monthly_budget_usd: toNum(f.monthly_budget_usd), monthly_fee_usd: toNum(f.monthly_fee_usd), inactivity_days: Number.isFinite(inact) ? inact : undefined,
    }), 'Paramètres enregistrés.');
    if (ok) reload();
  };
  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try { await api.post(`/api/admin/clients/${c.id}/logo`, fd); toast('Logo mis à jour.'); reload(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const archive = async () => {
    const arch = !c.archived_at;
    const r = await confirm({ title: arch ? 'Archiver le client' : 'Désarchiver le client', danger: arch, confirmLabel: arch ? 'Archiver' : 'Désarchiver',
      message: arch ? <>« {c.name} » n’apparaîtra plus dans les listes ni dans les rapports automatiques. Ses données sont conservées.</> : <>« {c.name} » réapparaîtra dans les listes.</> });
    if (r.ok && await run(() => api.patch(`/api/admin/clients/${c.id}`, { archived: arch }), arch ? 'Client archivé.' : 'Client désarchivé.')) reload();
  };
  return (
    <div className="ag-2-1">
      <Card title="Paramètres du client">
        <form className="form" onSubmit={save}>
          <div className="form-grid">
            <label className="field">Nom<input required {...txt('name')} /></label>
            <label className="field">Code<input value={c.code} disabled /><span className="help">Étiquette n8n : <span className="mono">client:{c.code}</span></span></label>
            <label className="field">Nom du contact<input {...txt('contact_name')} /></label>
            <label className="field">E-mail du contact<input type="email" {...txt('contact_email')} /></label>
            <label className="field">Téléphone<input type="tel" {...txt('contact_phone')} /></label>
          </div>
          <label className="field">Notes internes<span className="help">Jamais visibles par le client.</span><textarea {...txt('notes')} /></label>

          <div className="ag-form-section">
            <h3>Autorisations dans le portail</h3>
            <div className="ag-checks">
              <label className="check"><input type="checkbox" {...chk('can_toggle')} /><span>Activer / désactiver ses automatisations</span></label>
              <label className="check"><input type="checkbox" {...chk('can_retry')} /><span>Relancer une exécution en échec</span></label>
              <label className="check"><input type="checkbox" {...chk('show_costs')} /><span>Voir les coûts IA</span></label>
              <label className="check"><input type="checkbox" {...chk('show_reports')} /><span>Voir les rapports mensuels</span></label>
            </div>
            <p className="muted small" style={{ margin: '.5rem 0 0' }}>Chaque workflow peut en plus restreindre ces droits depuis sa fiche.</p>
          </div>

          <div className="ag-form-section">
            <h3>Rapport mensuel</h3>
            <label className="check"><input type="checkbox" {...chk('report_email_enabled')} /><span>Envoyer automatiquement le rapport par e-mail</span></label>
            <label className="field" style={{ marginTop: '.6rem' }}>Destinataires<span className="help">Adresses séparées par des virgules.</span>
              <input {...txt('report_emails')} placeholder="direction@client.com, compta@client.com" disabled={!f.report_email_enabled} />
            </label>
          </div>

          <div className="ag-form-section">
            <h3>Finances et surveillance</h3>
            <div className="form-grid">
              <label className="field">Facturation mensuelle ($US)<input inputMode="decimal" {...txt('monthly_fee_usd')} placeholder="Non renseignée" /></label>
              <label className="field">Budget IA mensuel ($US)<span className="help">Au-delà, le client est signalé « à risque ».</span><input inputMode="decimal" {...txt('monthly_budget_usd')} placeholder="Aucun" /></label>
              <label className="field">Inactivité tolérée (jours)<span className="help">Sans exécution au-delà, le client est signalé « à risque ».</span><input type="number" min={1} max={365} {...txt('inactivity_days')} /></label>
            </div>
            <label className="check" style={{ marginTop: '.6rem' }}><input type="checkbox" {...chk('is_internal')} /><span>Client interne (automatisations de l’agence)</span></label>
          </div>

          <div className="ag-form-foot">
            <button type="button" className="btn" onClick={() => setF(init)} disabled={busy}>Annuler les modifications</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </form>
      </Card>
      <div className="stack">
        <Card title="Logo">
          <div className="row">
            {c.logo_path ? <img className="ag-logo" style={{ width: 80, height: 80 }} src={`/api/clients/${c.id}/logo?v=${encodeURIComponent(c.updated_at ?? '')}`} alt={`Logo de ${c.name}`} /> : <Initials name={c.name} />}
            <div className="grow small muted">Affiché dans le portail du client et sur ses rapports. PNG, JPEG, WebP ou SVG, 2 Mo maximum.</div>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" id="logo-file"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <div style={{ marginTop: '.8rem' }}><button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Envoi…' : c.logo_path ? 'Remplacer le logo' : 'Ajouter un logo'}</button></div>
        </Card>
        <Card title="Archivage">
          <p className="small muted">{c.archived_at ? `Client archivé le ${fmtDate(c.archived_at)}.` : 'Archiver un client masque ses données sans les supprimer.'}</p>
          <button className={`btn ${c.archived_at ? '' : 'danger'}`} onClick={archive} disabled={busy}>{c.archived_at ? 'Désarchiver' : 'Archiver le client'}</button>
        </Card>
      </div>
    </div>
  );
}

function AlertsTab({ d, reload }: { d: Detail; reload: () => void }) {
  const { run, busy } = useAction();
  const act = async (id: number, a: string, msg: string) => { if (await run(() => api.post(`/api/admin/alerts/${id}/${a}`), msg)) reload(); };
  return (
    <div className="stack">
      <Card title="Alertes récentes" actions={<Link to="/agence/alertes" className="small">Toutes les alertes</Link>}>
        {d.alerts.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Gravité</th><th>Alerte</th><th className="num">Occurrences</th><th>Vue en dernier</th><th>Statut</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {d.alerts.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td><strong>{a.title}</strong><span className="ag-sub" style={{ whiteSpace: 'pre-line' }}>{a.message}</span></td>
                    <td className="num">{fmtNum(a.occurrences)}</td>
                    <td><Ago at={a.last_seen_at} /></td>
                    <td><AlertStatusBadge status={a.status} /></td>
                    <td className="actions">
                      {a.status === 'open' && <button className="btn small" disabled={busy} onClick={() => act(a.id, 'acknowledge', 'Alerte prise en compte.')}>Prendre en compte</button>}
                      {a.status !== 'resolved' ? <button className="btn small" disabled={busy} onClick={() => act(a.id, 'resolve', 'Alerte résolue.')}>Résoudre</button>
                        : <button className="btn small" disabled={busy} onClick={() => act(a.id, 'reopen', 'Alerte rouverte.')}>Rouvrir</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Aucune alerte pour ce client.</Empty>}
      </Card>
      <Card title="Journal des actions sur les workflows">
        <ActionLogTable rows={d.actions} />
      </Card>
    </div>
  );
}

function CostsTab({ d }: { d: Detail }) {
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of d.costs) m.set(r.day, (m.get(r.day) ?? 0) + Number(r.cost_usd));
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, cost_usd]) => ({ day, cost_usd }));
  }, [d.costs]);
  const byModel = useMemo(() => {
    const m = new Map<string, { provider: string; model: string; cost_usd: number }>();
    for (const r of d.costs) { const k = `${r.provider}|${r.model}`; const x = m.get(k) ?? { provider: r.provider, model: r.model, cost_usd: 0 }; x.cost_usd += Number(r.cost_usd); m.set(k, x); }
    return [...m.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  }, [d.costs]);
  const total = byModel.reduce((s, r) => s + r.cost_usd, 0);
  const max = Math.max(0, ...byModel.map((r) => r.cost_usd));
  const s = d.summary;
  return (
    <div className="stack">
      <div className="grid cols-3">
        <Stat label="Coût IA du mois" value={fmtUsd(s.llm_month_usd)} tone={s.monthly_budget_usd && s.llm_month_usd >= s.monthly_budget_usd ? 'bad' : undefined} hint={s.monthly_budget_usd ? `Budget : ${fmtUsd(s.monthly_budget_usd)}` : 'Aucun budget défini'} />
        <Stat label="Coût IA sur 90 jours" value={fmtUsd(total)} />
        <Stat label="Facturation mensuelle" value={fmtUsd(s.monthly_fee_usd)} hint={s.monthly_fee_usd ? `Marge du mois : ${fmtUsd(s.monthly_fee_usd - s.llm_month_usd)}` : undefined} />
      </div>
      <div className="ag-2-1">
        <Card title="Coût par jour (90 jours)" actions={<Link to="/agence/couts" className="small">Tous les coûts</Link>}>
          <CostBars data={byDay} />
        </Card>
      <Card title="Par modèle (90 jours)">
        {byModel.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Modèle</th><th className="num">Coût</th><th style={{ width: '25%' }}>Part</th></tr></thead>
              <tbody>{byModel.map((r) => (
                <tr key={`${r.provider}|${r.model}`}><td className="nowrap"><span className="mono">{r.model}</span><span className="ag-sub">{r.provider}</span></td><td className="num">{fmtUsd(r.cost_usd)}</td><td><ShareBar value={r.cost_usd} max={max} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <Empty>Aucun coût enregistré sur 90 jours.</Empty>}
      </Card>
      </div>
    </div>
  );
}
