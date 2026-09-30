import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { fromNow } from '../lib/format';

function Notifications({ light }: { light?: boolean }) {
  const { data, reload } = useApi<{ items: any[]; unread: number }>('/api/notifications');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);
  const markAll = async () => {
    await api.post('/api/notifications/read', {});
    reload();
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost small" style={light ? { color: '#fff' } : undefined} onClick={() => setOpen(!open)} aria-label="Notifications" aria-expanded={open}>
        🔔{data?.unread ? <span className="badge bad" style={{ marginLeft: 2 }}>{data.unread}</span> : null}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: '110%', width: 340, maxHeight: 420, overflowY: 'auto', zIndex: 60, padding: '.6rem', color: 'var(--text)' }}>
          <div className="row between" style={{ padding: '0 .3rem .4rem' }}>
            <strong>Notifications</strong>
            {!!data?.unread && <button className="linkbtn small" onClick={markAll}>Tout marquer comme lu</button>}
          </div>
          {!data?.items.length && <div className="empty small">Aucune notification.</div>}
          {data?.items.map((n) => (
            <button key={n.id} className="linkbtn" style={{ display: 'block', textAlign: 'left', width: '100%', padding: '.5rem .3rem', borderTop: '1px solid var(--border)', color: 'var(--text)', opacity: n.read_at ? 0.65 : 1 }}
              onClick={() => { setOpen(false); if (n.link) nav(n.link); }}>
              <div style={{ fontWeight: n.read_at ? 400 : 600 }}>{n.title}</div>
              <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{n.body.slice(0, 160)}</div>
              <div className="small muted">{fromNow(n.created_at)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const agencyNav: [string, string, string][] = [
  ['/agence', 'Tableau de bord', '▦'],
  ['/agence/clients', 'Clients', '◉'],
  ['/agence/workflows', 'Workflows', '⇄'],
  ['/agence/executions', 'Exécutions', '≡'],
  ['/agence/erreurs', 'Erreurs', '⚠'],
  ['/agence/alertes', 'Alertes', '🔔'],
  ['/agence/demandes', 'Demandes', '✉'],
];
const agencyNav2: [string, string, string][] = [
  ['/agence/couts', 'Coûts IA', '$'],
  ['/agence/rapports', 'Rapports et rentabilité', '▤'],
  ['/agence/instances', 'Instances n8n', '⚙'],
  ['/agence/parametres', 'Paramètres', '☰'],
  ['/agence/journal', 'Journal d’audit', '⎙'],
];

export function AgencyLayout() {
  const { user, brand, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const link = ([to, label, icon]: [string, string, string]) => (
    <NavLink key={to} to={to} end={to === '/agence'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span aria-hidden="true" style={{ width: 18, textAlign: 'center' }}>{icon}</span>{label}
    </NavLink>
  );
  return (
    <div className="app">
      <div className="topbar">
        <button className="btn ghost small" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
        <strong>{brand?.productName ?? 'Jadip Flow'}</strong>
        <span className="grow" />
        <Notifications light />
      </div>
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <div className="logo"><img src="/brand/icon.svg" alt="" />{brand?.productName ?? 'Jadip Flow'}</div>
        <nav>{agencyNav.map(link)}</nav>
        <div className="section">Gestion</div>
        <nav>{agencyNav2.map(link)}</nav>
        <div className="foot">
          <div className="row between">
            <NavLink to="/agence/compte" style={{ color: '#fff' }}>{user?.name}</NavLink>
            <span className="desktop-only"><Notifications light /></span>
          </div>
          <button className="linkbtn small" onClick={logout} style={{ color: 'rgba(255,255,255,.8)' }}>Se déconnecter</button>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}

const portalNav: [string, string, string, (u: any) => boolean][] = [
  ['/portail', 'Automatisations', '⇄', () => true],
  ['/portail/demandes', 'Demandes', '✉', () => true],
  ['/portail/couts', 'Coûts', '$', (u) => !!u?.show_costs],
  ['/portail/rapports', 'Rapports', '▤', (u) => !!u?.show_reports],
  ['/portail/compte', 'Mon compte', '☺', () => true],
];

export function PortalLayout() {
  const { user, brand, logout } = useAuth();
  const items = portalNav.filter(([, , , show]) => show(user));
  const nav = (mobile: boolean) => items.map(([to, label, icon]) => (
    <NavLink key={to} to={to} end={to === '/portail'} className={({ isActive }) => (isActive ? 'active' : '')}>
      {mobile && <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>{icon}</span>}{label}
    </NavLink>
  ));
  return (
    <>
      <header className="portal-head">
        <div className="inner">
          <div className="brandmark">
            {user?.client_logo ? <img src={`/api/clients/${user.client_id}/logo`} alt={user.client_name ?? ''} /> : <img src="/brand/icon.svg" alt="" />}
            <span className="brandname">{user?.client_name ?? brand?.productName}</span>
          </div>
          <nav className="portal-nav">{nav(false)}</nav>
          <span className="grow" style={{ flex: 1 }} />
          <Notifications />
          <button className="btn ghost small hide-mobile" onClick={logout}>Déconnexion</button>
        </div>
      </header>
      <main className="portal-main"><Outlet /></main>
      <nav className="bottom-nav">{nav(true)}</nav>
      <footer className="muted small" style={{ textAlign: 'center', padding: '0 1rem 2rem' }}>
        {brand?.productName} · un service de {brand?.companyName} · <a href={`mailto:${brand?.supportEmail}`}>{brand?.supportEmail}</a>
      </footer>
    </>
  );
}

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  const { brand } = useAuth();
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="brandline"><img src="/brand/icon.svg" alt="" />{brand?.productName ?? 'Jadip Flow'}</div>
        <h1 style={{ fontSize: '1.25rem' }}>{title}</h1>
        {children}
        <p className="small muted" style={{ marginTop: '1.2rem', marginBottom: 0 }}>{brand?.companyName} · {brand?.tagline}</p>
      </div>
    </div>
  );
}
