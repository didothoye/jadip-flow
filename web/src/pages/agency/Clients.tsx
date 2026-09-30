import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDuration, fmtNum, fmtUsd } from '../../lib/format';
import { Async, Badge, Card, Empty, Modal, PageHead, useAction } from '../../components/ui';
import { Ago, Rate, RiskBadge, toNum } from './shared';

export interface ClientSummary {
  id: string; code: string; name: string; is_internal: boolean; logo_path: string | null; monthly_budget_usd: number | null; monthly_fee_usd: number | null;
  inactivity_days: number; archived_at: string | null; workflows: number; workflows_active: number; last_execution_at: string | null;
  exec_30d: number; ok_30d: number; fail_30d: number; exec_7d: number; fail_7d: number; minutes_saved_month: number; llm_month_usd: number;
  alerts_open: number; tickets_open: number; success_rate_30d: number | null; at_risk: boolean; risks: string[];
}

export function BudgetCell({ spent, budget }: { spent: number; budget: number | null }) {
  if (!budget) return <>{fmtUsd(spent)}<span className="ag-sub">sans budget</span></>;
  const pct = spent / budget;
  const color = pct >= 1 ? 'var(--bad)' : pct >= 0.8 ? 'var(--warn)' : undefined;
  return <><span style={{ color, fontWeight: pct >= .8 ? 600 : undefined }}>{fmtUsd(spent)}</span><span className="ag-sub">sur {fmtUsd(budget)} ({fmtNum(pct * 100)} %)</span></>;
}

export default function Clients() {
  useTitle('Clients');
  const r = useApi<ClientSummary[]>('/api/admin/clients');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <div className="stack">
      <PageHead title="Clients" sub="Suivi de l’activité, des coûts et des risques par client."
        actions={<button className="btn primary" onClick={() => setCreating(true)}>Nouveau client</button>} />
      <Async {...r}>
        {(rows) => {
          const archived = rows.filter((c) => c.archived_at).length;
          const list = rows.filter((c) => showArchived || !c.archived_at);
          return (
            <Card title={`${list.length} client(s)`} actions={archived ? (
              <label className="check small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Afficher les archivés ({archived})</label>
            ) : undefined}>
              {list.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Client</th><th className="num">Workflows actifs</th><th className="num">Exécutions 30 j</th><th className="num">Réussite</th>
                        <th>Dernière exécution</th><th className="num" title="Temps gagné ce mois">Temps gagné</th><th className="num" title="Coût IA du mois">Coût IA (mois)</th><th className="num">Alertes</th><th>Santé</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((c) => (
                        <tr key={c.id} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) nav(`/agence/clients/${c.id}`); }}>
                          <td className="ag-name">
                            <Link to={`/agence/clients/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link>
                            <span className="ag-sub mono">client:{c.code}</span>
                            <span className="row" style={{ gap: '.3rem', marginTop: '.2rem' }}>
                              {c.is_internal && <Badge>Interne</Badge>}
                              {c.archived_at && <Badge>Archivé</Badge>}
                              {c.tickets_open > 0 && <Badge tone="info">{c.tickets_open} demande(s)</Badge>}
                            </span>
                          </td>
                          <td className="num">{fmtNum(c.workflows_active)} / {fmtNum(c.workflows)}</td>
                          <td className="num">{fmtNum(c.exec_30d)}</td>
                          <td className="num"><Rate value={c.success_rate_30d} /></td>
                          <td><Ago at={c.last_execution_at} /></td>
                          <td className="num">{fmtDuration(c.minutes_saved_month)}</td>
                          <td className="num"><BudgetCell spent={c.llm_month_usd} budget={c.monthly_budget_usd} /></td>
                          <td className="num">{c.alerts_open ? <Badge tone="bad">{c.alerts_open}</Badge> : <span className="muted">0</span>}</td>
                          <td><RiskBadge risks={c.risks} />{c.risks.map((x) => <span key={x} className="ag-sub" style={{ color: 'var(--bad)' }}>{x}</span>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>Aucun client pour l’instant. Créez-en un pour rattacher ses workflows.</Empty>}
            </Card>
          );
        }}
      </Async>
      {creating && <NewClientModal onClose={() => setCreating(false)} onCreated={(id) => nav(`/agence/clients/${id}`)} />}
    </div>
  );
}

function NewClientModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ code: '', name: '', contact_name: '', contact_email: '', contact_phone: '', is_internal: false, monthly_fee: '', monthly_budget: '' });
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const codeOk = /^[a-z0-9][a-z0-9-]{0,39}$/.test(f.code);
  const suggest = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = await run(() => api.post<{ id: string }>('/api/admin/clients', {
      code: f.code, name: f.name.trim(), contact_name: f.contact_name.trim() || null, contact_email: f.contact_email.trim() || null,
      contact_phone: f.contact_phone.trim() || null, is_internal: f.is_internal,
      monthly_fee_usd: toNum(f.monthly_fee), monthly_budget_usd: toNum(f.monthly_budget),
    }), 'Client créé.');
    if (c) onCreated(c.id);
  };
  return (
    <Modal title="Nouveau client" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">Nom
          <input required value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value, code: f.code === suggest(f.name) ? suggest(e.target.value) : f.code })} placeholder="Boulangerie Kivu" />
        </label>
        <label className="field">Code
          <span className="help">Minuscules, chiffres et tirets. Les workflows portant l’étiquette <span className="mono">client:{f.code || 'code'}</span> dans n8n lui seront rattachés automatiquement.</span>
          <input required value={f.code} onChange={set('code')} pattern="[a-z0-9][a-z0-9\-]{0,39}" aria-invalid={!!f.code && !codeOk} placeholder="kivu" />
        </label>
        <div className="form-grid">
          <label className="field">Nom du contact<input value={f.contact_name} onChange={set('contact_name')} /></label>
          <label className="field">E-mail du contact<input type="email" value={f.contact_email} onChange={set('contact_email')} /></label>
          <label className="field">Téléphone<input type="tel" value={f.contact_phone} onChange={set('contact_phone')} /></label>
          <label className="field">Facturation mensuelle ($US)<input inputMode="decimal" value={f.monthly_fee} onChange={set('monthly_fee')} placeholder="0" /></label>
          <label className="field">Budget IA mensuel ($US)<input inputMode="decimal" value={f.monthly_budget} onChange={set('monthly_budget')} placeholder="Aucun" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.is_internal} onChange={set('is_internal')} /><span>Client interne (automatisations de l’agence)</span></label>
        <div className="ag-form-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={busy || !codeOk || !f.name.trim()}>{busy ? 'Création…' : 'Créer le client'}</button>
        </div>
      </form>
    </Modal>
  );
}
