import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi, useTitle } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Card, Modal, PageHead, useAction, useUi } from '../components/ui';

export default function Account() {
  useTitle('Mon compte');
  const { user, setUser, logout } = useAuth();
  const { run, busy } = useAction();
  if (!user) return null;
  const isAdmin = user.role === 'admin';
  const save = (patch: Record<string, unknown>) => run(async () => setUser((await api.patch('/api/me', patch)).user), 'Préférences enregistrées.');
  return (
    <div className="stack">
      <PageHead title="Mon compte" sub={user.email} actions={<button className="btn" onClick={logout}>Se déconnecter</button>} />
      <div className="grid cols-2">
        <Card title="Notifications">
          <div className="form">
            <p className="muted small">Choisissez comment {isAdmin ? 'vous êtes' : 'vous souhaitez être'} prévenu{isAdmin ? '' : '(e)'}.</p>
            <label className="check"><input type="checkbox" checked={user.notify_email} onChange={(e) => save({ notify_email: e.target.checked })} disabled={busy} />Par e-mail</label>
            <label className="check"><input type="checkbox" checked={user.notify_telegram} onChange={(e) => save({ notify_telegram: e.target.checked })} disabled={busy} />Par Telegram</label>
            {user.notify_telegram && <TelegramId value={user.telegram_chat_id} onSave={(v) => save({ telegram_chat_id: v || null })} />}
            {!isAdmin && <>
              <label className="check"><input type="checkbox" checked={user.notify_on_error} onChange={(e) => save({ notify_on_error: e.target.checked })} disabled={busy} />
                <span>Me prévenir quand une automatisation rencontre un incident</span></label>
              <label className="check"><input type="checkbox" checked={user.notify_weekly_summary} onChange={(e) => save({ notify_weekly_summary: e.target.checked })} disabled={busy} />
                <span>Recevoir un résumé chaque semaine</span></label>
            </>}
          </div>
        </Card>
        <Security />
      </div>
      <Password />
      {isAdmin && <ApiTokens />}
    </div>
  );
}

function TelegramId({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [v, setV] = useState(value ?? '');
  return (
    <div className="row" style={{ alignItems: 'flex-end' }}>
      <label className="field grow">Votre identifiant Telegram
        <span className="help">Écrivez à @userinfobot sur Telegram : il vous donne ce numéro.</span>
        <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} placeholder="123456789" />
      </label>
      <button className="btn" onClick={() => onSave(v.trim())}>Enregistrer</button>
    </div>
  );
}

function Security() {
  const { user, refresh } = useAuth();
  const { run } = useAction();
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [disable, setDisable] = useState(false);
  const [pw, setPw] = useState('');
  return (
    <Card title="Double authentification">
      {user?.totp_enabled ? (
        <div className="stack">
          <div className="alert success">Activée : un code vous est demandé à chaque connexion.</div>
          <div><button className="btn danger" onClick={() => setDisable(true)}>Désactiver</button></div>
        </div>
      ) : setup ? (
        <div className="stack">
          <p className="small">Scannez ce QR code avec Google Authenticator, Microsoft Authenticator ou une application similaire, puis saisissez le code affiché.</p>
          <img src={setup.qr} alt="QR code de double authentification" style={{ width: 180, height: 180, background: '#fff', padding: 6, borderRadius: 8 }} />
          <p className="small muted">Clé manuelle : <span className="mono">{setup.secret}</span></p>
          <div className="row">
            <input inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 140 }} />
            <button className="btn primary" onClick={() => run(async () => { await api.post('/api/me/totp/enable', { code }); setSetup(null); await refresh(); }, 'Double authentification activée.')}>Activer</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="small">Recommandé : protège votre compte même si votre mot de passe est découvert.</p>
          <div><button className="btn primary" onClick={() => run(async () => setSetup(await api.post('/api/me/totp/setup', {})))}>Configurer</button></div>
        </div>
      )}
      {disable && (
        <Modal title="Désactiver la double authentification" onClose={() => setDisable(false)} actions={<>
          <button className="btn" onClick={() => setDisable(false)}>Annuler</button>
          <button className="btn danger solid" onClick={() => run(async () => { await api.post('/api/me/totp/disable', { password: pw }); setDisable(false); await refresh(); }, 'Double authentification désactivée.')}>Désactiver</button>
        </>}>
          <label className="field">Confirmez avec votre mot de passe<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
        </Modal>
      )}
    </Card>
  );
}

function Password() {
  const { run, busy } = useAction();
  const [f, setF] = useState({ current: '', password: '', confirm: '' });
  return (
    <Card title="Mot de passe">
      <form className="form-grid" onSubmit={(e) => {
        e.preventDefault();
        if (f.password !== f.confirm) return;
        run(async () => { await api.post('/api/me/password', { current: f.current, password: f.password }); setF({ current: '', password: '', confirm: '' }); }, 'Mot de passe modifié.');
      }}>
        <label className="field">Mot de passe actuel<input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></label>
        <span />
        <label className="field">Nouveau mot de passe<input type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></label>
        <label className="field">Confirmation<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />
          {f.confirm && f.confirm !== f.password && <span className="help" style={{ color: 'var(--bad)' }}>Les mots de passe diffèrent.</span>}</label>
        <div><button className="btn primary" disabled={busy}>Modifier le mot de passe</button></div>
      </form>
    </Card>
  );
}

function ApiTokens() {
  const { data, reload } = useApi<any[]>('/api/tokens');
  const { run } = useAction();
  const { confirm } = useUi();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Card title="Jetons d’API et MCP" actions={<a className="btn small" href="/api/docs" target="_blank" rel="noreferrer">Documentation de l’API</a>}>
      <p className="small muted">Pour l’API REST (<span className="mono">/api/v1</span>) et le serveur MCP (<span className="mono">/mcp</span>) utilisé par Claude Code. Le jeton n’est affiché qu’une seule fois.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/tokens', { name, scopes: write ? ['read', 'write'] : ['read'] }); setCreated(r.token); setName(''); reload(); }); }}>
        <input placeholder="Nom du jeton (ex. Claude Code)" value={name} onChange={(e) => setName(e.target.value)} required style={{ maxWidth: 280 }} />
        <label className="check"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />Autoriser les actions (activer / désactiver)</label>
        <button className="btn primary">Créer</button>
      </form>
      {created && (
        <div className="alert info" style={{ marginTop: '.8rem' }}>
          <strong>Copiez ce jeton maintenant :</strong> <span className="mono" style={{ wordBreak: 'break-all' }}>{created}</span>
          <div className="small" style={{ marginTop: '.4rem' }}>Claude Code : <span className="mono">claude mcp add --transport http jadip-flow {location.origin}/mcp --header "Authorization: Bearer {created}"</span></div>
        </div>
      )}
      <div className="table-wrap" style={{ marginTop: '.8rem' }}>
        <table className="table">
          <thead><tr><th>Nom</th><th>Préfixe</th><th>Portée</th><th>Dernière utilisation</th><th>État</th><th /></tr></thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td><td className="mono">{t.prefix}…</td><td>{t.scopes.includes('write') ? 'Lecture et actions' : 'Lecture'}</td>
                <td>{fmtDateTime(t.last_used_at)}</td><td>{t.revoked_at ? <span className="badge">Révoqué</span> : <span className="badge good">Actif</span>}</td>
                <td className="right">{!t.revoked_at && <button className="btn small danger" onClick={async () => {
                  if ((await confirm({ title: 'Révoquer ce jeton ?', message: `Les intégrations qui utilisent « ${t.name} » cesseront de fonctionner.`, danger: true, confirmLabel: 'Révoquer' })).ok) run(async () => { await api.del(`/api/tokens/${t.id}`); reload(); }, 'Jeton révoqué.');
                }}>Révoquer</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
