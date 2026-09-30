import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthShell } from '../../components/layouts';
import { ErrorBox, Loading } from '../../components/ui';
import { useTitle } from '../../lib/hooks';

export const homeFor = (role?: string) => (role === 'admin' ? '/agence' : '/portail');

export function LoginPage() {
  useTitle('Connexion');
  const { user, setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={homeFor(user.role)} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!mfa) {
        const r = await api.post('/api/auth/login', { email, password });
        if (r.mfaRequired) setMfa(true);
        else setUser(r.user);
      } else {
        const r = await api.post('/api/auth/mfa', { code: code.replace(/\s/g, '') });
        setUser(r.user);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title={mfa ? 'Code de vérification' : 'Connexion'}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        {!mfa ? (
          <>
            <label className="field">Adresse e-mail<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
            <label className="field">Mot de passe<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          </>
        ) : (
          <label className="field">Code à 6 chiffres de votre application d’authentification
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </label>
        )}
        <button className="btn primary block" disabled={busy}>{busy ? 'Connexion…' : mfa ? 'Valider' : 'Se connecter'}</button>
        {!mfa && <Link to="/mot-de-passe-oublie" className="small">Mot de passe oublié ?</Link>}
      </form>
    </AuthShell>
  );
}

function PasswordForm({ onSubmit, cta }: { onSubmit: (p: string) => Promise<void>; cta: string }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (p1 !== p2) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    setError(null);
    try { await onSubmit(p1); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form className="form" onSubmit={submit}>
      <ErrorBox error={error} />
      <label className="field">Nouveau mot de passe<span className="help">Au moins 10 caractères, avec des lettres et des chiffres.</span>
        <input type="password" autoComplete="new-password" required minLength={10} value={p1} onChange={(e) => setP1(e.target.value)} autoFocus /></label>
      <label className="field">Confirmez le mot de passe<input type="password" autoComplete="new-password" required value={p2} onChange={(e) => setP2(e.target.value)} /></label>
      <button className="btn primary block" disabled={busy}>{cta}</button>
    </form>
  );
}

export function ActivatePage() {
  useTitle('Activation du compte');
  const { token } = useParams();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ email: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get(`/api/auth/invite/${token}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  return (
    <AuthShell title="Activez votre compte">
      {error ? <><ErrorBox error={error} /><p className="small" style={{ marginTop: '1rem' }}>Demandez un nouveau lien à votre contact chez Jadip Services.</p></> : !info ? <Loading /> : (
        <>
          <p>Bienvenue {info.name}. Choisissez votre mot de passe pour <strong>{info.email}</strong>.</p>
          <PasswordForm cta="Activer mon compte" onSubmit={async (password) => {
            const r = await api.post('/api/auth/activate', { token, password });
            setUser(r.user);
            nav(homeFor(r.user.role), { replace: true });
          }} />
        </>
      )}
    </AuthShell>
  );
}

export function ForgotPage() {
  useTitle('Mot de passe oublié');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <AuthShell title="Mot de passe oublié">
      {sent ? <div className="alert success">Si un compte existe pour cette adresse, un e-mail vient d’être envoyé avec un lien valable 2 heures.</div> : (
        <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.post('/api/auth/forgot', { email }).catch(() => {}); setSent(true); }}>
          <label className="field">Adresse e-mail<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          <button className="btn primary block">Recevoir un lien</button>
        </form>
      )}
      <p style={{ marginTop: '1rem' }}><Link to="/connexion" className="small">← Retour à la connexion</Link></p>
    </AuthShell>
  );
}

export function ResetPage() {
  useTitle('Nouveau mot de passe');
  const { token } = useParams();
  const [done, setDone] = useState(false);
  return (
    <AuthShell title="Nouveau mot de passe">
      {done ? <div className="alert success">Mot de passe modifié. <Link to="/connexion">Se connecter</Link></div>
        : <PasswordForm cta="Enregistrer" onSubmit={async (password) => { await api.post('/api/auth/reset', { token, password }); setDone(true); }} />}
    </AuthShell>
  );
}
