import { useState, type FormEvent } from 'react';
import { api, qs } from '../../lib/api';
import { useApi, useTitle } from '../../lib/hooks';
import { fmtDateTime, fmtMs, fmtNum } from '../../lib/format';
import { Async, Badge, Card, Empty, HealthBadge, Modal, PageHead, useAction, useUi } from '../../components/ui';
import { Ago } from './shared';

interface Instance {
  id: string; name: string; base_url: string; public_url: string | null; sync_enabled: boolean; sync_interval_minutes: number; retention_days: number;
  health_status: string; health_message: string | null; health_checked_at: string | null; last_sync_at: string | null; last_sync_status: string | null;
  consecutive_sync_failures: number; api_key_hint: string; workflows: number; workflows_active: number; executions_24h: number; clients: string[] | null;
}
interface SyncRun {
  id: number; instance_id: string; instance_name: string; trigger: string; status: string; started_at: string; duration_ms: number | null; workflows_seen: number | null;
  workflows_created: number | null; workflows_renamed: number | null; workflows_deleted: number | null; executions_imported: number | null; error_message: string | null;
}
interface SyncSummary { status: 'success' | 'error' | 'skipped'; workflowsSeen: number; created: number; renamed: number; deleted: number; executionsImported: number; durationMs: number; error?: string }

export default function Instances() {
  useTitle('Instances n8n');
  const r = useApi<Instance[]>('/api/admin/instances');
  const [journalFor, setJournalFor] = useState('');
  const runs = useApi<SyncRun[]>(`/api/admin/sync-runs${qs({ instance_id: journalFor, limit: 50 })}`);
  const [edit, setEdit] = useState<Instance | 'new' | null>(null);
  const [summary, setSummary] = useState<{ name: string; s: SyncSummary } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast, confirm } = useUi();
  const reloadAll = () => { r.reload(); runs.reload(); };
  const sync = async (i: Instance) => {
    setBusyId(i.id);
    try { const s = await api.post<SyncSummary>(`/api/admin/instances/${i.id}/sync`); setSummary({ name: i.name, s }); reloadAll(); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusyId(null); }
  };
  const health = async (i: Instance) => {
    setBusyId(i.id);
    try { const h = await api.post<{ status: string; message: string }>(`/api/admin/instances/${i.id}/health`); toast(h.message, h.status === 'ok' ? 'ok' : 'error'); r.reload(); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusyId(null); }
  };
  const remove = async (i: Instance) => {
    const c = await confirm({ title: 'Supprimer l’instance', danger: true, confirmLabel: 'Supprimer définitivement',
      message: <>Tous les workflows ({fmtNum(i.workflows)}) et l’historique des exécutions de « {i.name} » seront supprimés de Jadip Flow. Rien n’est modifié dans n8n.<br /><br />Tapez le nom de l’instance pour confirmer.</>,
      input: { label: 'Nom de l’instance', placeholder: i.name } });
    if (!c.ok) return;
    if (c.value?.trim() !== i.name) { toast('Le nom saisi ne correspond pas : suppression annulée.', 'error'); return; }
    try { await api.del(`/api/admin/instances/${i.id}`); toast('Instance supprimée.'); reloadAll(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <div className="stack">
      <PageHead title="Instances n8n" sub="Serveurs n8n supervisés. Les clés API sont chiffrées et ne sont jamais réaffichées."
        actions={<button className="btn primary" onClick={() => setEdit('new')}>Ajouter une instance</button>} />
      <Async {...r}>
        {(rows) => rows.length ? (
          <div className="grid auto">
            {rows.map((i) => (
              <Card key={i.id} title={i.name} actions={<HealthBadge status={i.health_status} />}>
                <div className="stack" style={{ gap: '.6rem' }}>
                  <div className="small">
                    <div className="mono" style={{ wordBreak: 'break-all' }}>{i.base_url}</div>
                    {i.public_url && i.public_url !== i.base_url && <div className="muted">Adresse publique : <span className="mono">{i.public_url}</span></div>}
                    <div className="muted">Clé API : <span className="mono">{i.api_key_hint}</span></div>
                  </div>
                  {i.health_message && i.health_status !== 'ok' && <div className="alert error small">{i.health_message}</div>}
                  <div className="wf-card"><div className="facts">
                    <div><div className="k">Workflows</div><div className="v">{fmtNum(i.workflows_active)} / {fmtNum(i.workflows)}</div></div>
                    <div><div className="k">Exécutions 24 h</div><div className="v">{fmtNum(i.executions_24h)}</div></div>
                    <div><div className="k">Clients</div><div className="v">{fmtNum(i.clients?.length ?? 0)}</div></div>
                  </div></div>
                  <div className="small">
                    <div>Dernière synchro : <Ago at={i.last_sync_at} />{' '}
                      {i.last_sync_status === 'error' ? <Badge tone="bad">Échec</Badge> : i.last_sync_status === 'success' ? <Badge tone="good">Réussie</Badge> : null}
                      {i.consecutive_sync_failures > 1 && <span style={{ color: 'var(--bad)' }}> · {i.consecutive_sync_failures} échecs consécutifs</span>}</div>
                    <div className="muted">{i.sync_enabled ? `Synchronisation toutes les ${i.sync_interval_minutes} min` : 'Synchronisation automatique désactivée'} · conservation {fmtNum(i.retention_days)} jours</div>
                    {!!i.clients?.length && <div className="muted">Clients servis : {i.clients.join(', ')}</div>}
                  </div>
                  <div className="row" style={{ gap: '.4rem' }}>
                    <button className="btn small primary" disabled={busyId === i.id} onClick={() => sync(i)}>{busyId === i.id ? 'En cours…' : 'Synchroniser maintenant'}</button>
                    <button className="btn small" disabled={busyId === i.id} onClick={() => health(i)}>Vérifier la connexion</button>
                    <button className="btn small" onClick={() => setEdit(i)}>Modifier</button>
                    <button className="btn small danger" onClick={() => remove(i)}>Supprimer</button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card><Empty>Aucune instance configurée.<br /><button className="btn primary" style={{ marginTop: '.8rem' }} onClick={() => setEdit('new')}>Ajouter une instance</button></Empty></Card>
        )}
      </Async>

      <Card title="Journal de synchronisation" actions={(r.data?.length ?? 0) > 1 ? (
        <select value={journalFor} onChange={(e) => setJournalFor(e.target.value)} aria-label="Instance" style={{ width: 'auto' }}>
          <option value="">Toutes les instances</option>
          {r.data!.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      ) : <button className="btn small" onClick={runs.reload}>Actualiser</button>}>
        <Async {...runs}>
          {(rows) => rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Début</th><th>Instance</th><th>Déclenchement</th><th>Statut</th><th className="num">Durée</th><th className="num">Workflows vus</th><th className="num">Créés / renommés / supprimés</th><th className="num">Exécutions importées</th><th>Erreur</th></tr></thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td className="nowrap">{fmtDateTime(s.started_at)}</td>
                      <td>{s.instance_name}</td>
                      <td>{s.trigger === 'manual' ? 'Manuel' : 'Planifié'}</td>
                      <td>{s.status === 'success' ? <Badge tone="good">Réussie</Badge> : s.status === 'error' ? <Badge tone="bad">Échec</Badge> : <Badge tone="info">En cours</Badge>}</td>
                      <td className="num">{fmtMs(s.duration_ms)}</td>
                      <td className="num">{fmtNum(s.workflows_seen)}</td>
                      <td className="num">{fmtNum(s.workflows_created)} / {fmtNum(s.workflows_renamed)} / {fmtNum(s.workflows_deleted)}</td>
                      <td className="num">{fmtNum(s.executions_imported)}</td>
                      <td className="small" style={{ color: s.error_message ? 'var(--bad)' : undefined }}>{s.error_message ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>Aucune synchronisation enregistrée.</Empty>}
        </Async>
      </Card>

      {edit && <InstanceModal inst={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reloadAll(); }} />}
      {summary && (
        <Modal title={`Synchronisation de « ${summary.name} »`} onClose={() => setSummary(null)} actions={<button className="btn primary" onClick={() => setSummary(null)}>Fermer</button>}>
          {summary.s.status === 'skipped' ? <div className="alert info">Une synchronisation est déjà en cours pour cette instance. Réessayez dans un instant.</div>
            : summary.s.status === 'error' ? <div className="alert error">Échec : {summary.s.error ?? 'erreur inconnue'}</div>
            : <div className="alert success">Synchronisation réussie en {fmtMs(summary.s.durationMs)}.</div>}
          {summary.s.status !== 'skipped' && (
            <table className="table" style={{ marginTop: '.8rem' }}>
              <tbody>
                <tr><td>Workflows vus</td><td className="num">{fmtNum(summary.s.workflowsSeen)}</td></tr>
                <tr><td>Nouveaux workflows</td><td className="num">{fmtNum(summary.s.created)}</td></tr>
                <tr><td>Workflows renommés</td><td className="num">{fmtNum(summary.s.renamed)}</td></tr>
                <tr><td>Workflows supprimés dans n8n</td><td className="num">{fmtNum(summary.s.deleted)}</td></tr>
                <tr><td>Exécutions importées</td><td className="num">{fmtNum(summary.s.executionsImported)}</td></tr>
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}

function InstanceModal({ inst, onClose, onSaved }: { inst: Instance | null; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    name: inst?.name ?? '', base_url: inst?.base_url ?? '', public_url: inst?.public_url ?? '', api_key: '',
    sync_enabled: inst?.sync_enabled ?? true, sync_interval_minutes: String(inst?.sync_interval_minutes ?? 5), retention_days: String(inst?.retention_days ?? 90),
  });
  const [test, setTest] = useState<{ reachable: boolean; authOk: boolean; message: string; key: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const testKey = `${f.base_url}|${f.api_key}`;
  const tested = test?.authOk && test.key === testKey;
  const doTest = async () => {
    setTesting(true);
    try {
      const body = f.api_key ? { base_url: f.base_url.trim(), api_key: f.api_key } : { base_url: f.base_url.trim(), id: inst?.id };
      const h = await api.post<{ reachable: boolean; authOk: boolean; message: string }>('/api/admin/instances/test', body);
      setTest({ ...h, key: testKey });
    } catch (e: any) { setTest({ reachable: false, authOk: false, message: e.message, key: testKey }); } finally { setTesting(false); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: f.name.trim(), base_url: f.base_url.trim().replace(/\/+$/, ''), public_url: f.public_url.trim() ? f.public_url.trim().replace(/\/+$/, '') : null,
      sync_enabled: f.sync_enabled, sync_interval_minutes: parseInt(f.sync_interval_minutes, 10) || 5, retention_days: parseInt(f.retention_days, 10) || 90,
    };
    if (f.api_key) body.api_key = f.api_key;
    const ok = await run(() => (inst ? api.patch(`/api/admin/instances/${inst.id}`, body) : api.post('/api/admin/instances', body)), inst ? 'Instance enregistrée.' : 'Instance ajoutée. Lancez une première synchronisation.');
    if (ok) onSaved();
  };
  const canTest = /^https?:\/\/.+/.test(f.base_url.trim()) && (!!f.api_key || !!inst);
  return (
    <Modal title={inst ? `Modifier « ${inst.name} »` : 'Ajouter une instance'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="n8n production" /></label>
        <label className="field">Adresse de l’API<span className="help">URL utilisée par Jadip Flow pour joindre n8n.</span>
          <input required type="url" value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} placeholder="https://n8n.exemple.com" />
        </label>
        <label className="field">Adresse publique (facultatif)<span className="help">Pour les liens « Ouvrir dans n8n », si elle diffère de l’adresse de l’API.</span>
          <input type="url" value={f.public_url} onChange={(e) => setF({ ...f, public_url: e.target.value })} placeholder="https://n8n.exemple.com" />
        </label>
        <label className="field">Clé API n8n
          <span className="help">{inst ? <>Actuelle : <span className="mono">{inst.api_key_hint}</span>. Laissez vide pour la conserver.</> : 'Paramètres de n8n → API. Elle est chiffrée et ne sera plus jamais affichée.'}</span>
          <input type="password" autoComplete="new-password" required={!inst} minLength={10} value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} placeholder={inst ? 'Inchangée' : ''} />
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={doTest} disabled={!canTest || testing}>{testing ? 'Test en cours…' : 'Tester la connexion'}</button>
          {test && test.key === testKey && <span className="small" style={{ color: test.authOk ? 'var(--good)' : 'var(--bad)', fontWeight: 600 }}>{test.authOk ? '✓ ' : '✗ '}{test.message}</span>}
        </div>
        <div className="form-grid">
          <label className="field">Intervalle de synchronisation (minutes)<input type="number" min={1} max={1440} value={f.sync_interval_minutes} onChange={(e) => setF({ ...f, sync_interval_minutes: e.target.value })} /></label>
          <label className="field">Conservation des exécutions (jours)<input type="number" min={1} max={3650} value={f.retention_days} onChange={(e) => setF({ ...f, retention_days: e.target.value })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.sync_enabled} onChange={(e) => setF({ ...f, sync_enabled: e.target.checked })} />Synchronisation automatique</label>
        {!inst && !tested && <p className="small muted" style={{ margin: 0 }}>Testez la connexion avant d’enregistrer.</p>}
        <div className="ag-form-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={busy || (!inst && !tested)}>{busy ? 'Enregistrement…' : inst ? 'Enregistrer' : 'Ajouter l’instance'}</button>
        </div>
      </form>
    </Modal>
  );
}
