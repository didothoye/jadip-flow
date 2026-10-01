import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { fromNow } from '../lib/format';
import { effectiveTheme, setTheme, type Theme } from '../lib/theme';
import { Icon, type IconName } from './icons';
import { useUi } from './ui';

const initials = (s?: string | null) => (s ?? '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

function Notifications({ flat }: { flat?: boolean }) {
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
      <button className={`icon-btn ${flat ? 'flat' : ''}`} onClick={() => setOpen(!open)} aria-label="Notifications" aria-expanded={open}>
        <Icon name="bell" />
        {data?.unread ? <span className="pip">{data.unread > 99 ? '99+' : data.unread}</span> : null}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: '115%', width: 340, maxWidth: 'calc(100vw - 2rem)', maxHeight: 440, overflowY: 'auto', zIndex: 60, padding: '.7rem', color: 'var(--text)' }}>
          <div className="row between" style={{ padding: '0 .3rem .5rem' }}>
            <strong>Notifications</strong>
            {!!data?.unread && <button className="linkbtn small" onClick={markAll}>Tout marquer comme lu</button>}
          </div>
          {!data?.items.length && <div className="empty small">Aucune notification.</div>}
          {data?.items.map((n) => (
            <button key={n.id} className="linkbtn" style={{ display: 'block', textAlign: 'left', width: '100%', padding: '.6rem .3rem', borderTop: '1px solid var(--border)', color: 'var(--text)', opacity: n.read_at ? 0.65 : 1 }}
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

export function ThemeToggle({ flat }: { flat?: boolean }) {
  const [t, setT] = useState<Theme>(effectiveTheme);
  const next: Theme = t === 'dark' ? 'light' : 'dark';
  return (
    <button className={`icon-btn ${flat ? 'flat' : ''}`} onClick={() => { setTheme(next); setT(next); }}
      aria-label={next === 'dark' ? 'Passer au thème sombre' : 'Passer au thème clair'} title={next === 'dark' ? 'Thème sombre' : 'Thème clair'}>
      <Icon name={t === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

/** Synchronise toutes les instances n8n, puis prévient les pages ouvertes (événement jf:synced). */
function SyncButton() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const list = await api.get<{ id: string }[]>('/api/admin/instances');
      if (!list.length) { toast('Aucune instance n8n à synchroniser.', 'error'); return; }
      const res = await Promise.allSettled(list.map((i) => api.post(`/api/admin/instances/${i.id}/sync`)));
      const ko = res.filter((r) => r.status === 'rejected').length;
      toast(ko ? `Synchronisation terminée avec ${ko} échec(s).` : 'Synchronisation terminée.', ko ? 'error' : 'ok');
      window.dispatchEvent(new Event('jf:synced'));
    } catch (e: any) {
      toast(e?.message ?? 'Synchronisation impossible.', 'error');
    } finally { setBusy(false); }
  };
  return (
    <button className="side-cta" onClick={run} disabled={busy}>
      <Icon name="sync" stroke={2.2} />{busy ? 'Synchronisation…' : 'Synchroniser n8n'}
    </button>
  );
}

type NavItem = [to: string, label: string, icon: IconName];
const agencyNav: NavItem[] = [
  ['/agence', 'Tableau de bord', 'home'],
  ['/agence/clients', 'Clients', 'users'],
  ['/agence/workflows', 'Workflows', 'flow'],
  ['/agence/executions', 'Exécutions', 'list'],
  ['/agence/erreurs', 'Erreurs', 'alert'],
  ['/agence/alertes', 'Alertes', 'bell'],
  ['/agence/demandes', 'Demandes', 'chat'],
];
const agencyNav2: NavItem[] = [
  ['/agence/couts', 'Coûts IA', 'coin'],
  ['/agence/rapports', 'Rapports et rentabilité', 'file'],
  ['/agence/instances', 'Instances n8n', 'server'],
  ['/agence/parametres', 'Paramètres', 'sliders'],
  ['/agence/journal', 'Journal d’audit', 'shield'],
];

export function AgencyLayout() {
  const { user, brand, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const link = ([to, label, icon]: NavItem) => (
    <NavLink key={to} to={to} end={to === '/agence'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon name={icon} />{label}
    </NavLink>
  );
  const product = brand?.productName ?? 'Jadip Flow';
  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn flat" onClick={() => setOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
        <img src="/brand/icon.svg" alt="" />
        <strong>{product}</strong>
        <span className="grow" />
        <Notifications flat />
      </div>
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <div className="logo">
          <img src="/brand/icon.svg" alt="" />
          <div>
            <div className="name">{product}</div>
            {brand?.tagline && <div className="tag">{brand.tagline.replace(/\.$/, '')}</div>}
          </div>
        </div>
        <nav>{agencyNav.map(link)}</nav>
        <div className="section">Gestion</div>
        <nav>{agencyNav2.map(link)}</nav>
        <SyncButton />
        <div className="foot">
          <NavLink to="/agence/compte" className="who">
            <span className="avatar">{initials(user?.name)}</span>
            <span style={{ minWidth: 0 }}>
              <span className="n" style={{ display: 'block' }}>{user?.name}</span>
              <span className="r">Agence · administrateur</span>
            </span>
          </NavLink>
          <div className="row" style={{ gap: '.5rem', flexWrap: 'nowrap' }}>
            <button className="logout grow" onClick={logout}><Icon name="logout" size={18} />Déconnexion</button>
            <ThemeToggle flat />
            <span className="desktop-only"><Notifications flat /></span>
          </div>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}

const portalNav: [string, string, IconName, (u: any) => boolean][] = [
  ['/portail', 'Automatisations', 'home', () => true],
  ['/portail/demandes', 'Demandes', 'chat', () => true],
  ['/portail/couts', 'Coûts', 'coin', (u) => !!u?.show_costs],
  ['/portail/rapports', 'Rapports', 'file', (u) => !!u?.show_reports],
  ['/portail/compte', 'Mon compte', 'user', () => true],
];

export function PortalLayout() {
  const { user, brand, logout } = useAuth();
  const items = portalNav.filter(([, , , show]) => show(user));
  const nav = (mobile: boolean) => items.map(([to, label, icon]) => (
    <NavLink key={to} to={to} end={to === '/portail'} className={({ isActive }) => (isActive ? 'active' : '')}>
      {mobile && <span className="pill"><Icon name={icon} /></span>}{mobile ? ({ Automatisations: 'Accueil', 'Mon compte': 'Compte' } as Record<string, string>)[label] ?? label : label}
    </NavLink>
  ));
  return (
    <>
      <header className="portal-head">
        <div className="inner">
          <div className="brandmark">
            {user?.client_logo ? <img src={`/api/clients/${user.client_id}/logo`} alt={user.client_name ?? ''} /> : <img src="/brand/icon.svg" alt="" />}
            <span style={{ minWidth: 0 }}>
              <span className="brandname" style={{ display: 'block' }}>{user?.client_name ?? brand?.productName}</span>
              {user?.client_name && <span className="by">par {brand?.productName ?? 'Jadip Flow'}</span>}
            </span>
          </div>
          <nav className="portal-nav">{nav(false)}</nav>
          <span className="grow" style={{ flex: 1 }} />
          <ThemeToggle flat />
          <Notifications flat />
          <button className="btn ghost small hide-mobile" onClick={logout}><Icon name="logout" size={16} />Déconnexion</button>
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
        <div className="brandline">
          <img src="/brand/icon.svg" alt="" />
          <div>
            <div className="name">{brand?.productName ?? 'Jadip Flow'}</div>
            {brand?.tagline && <div className="tag">{brand.tagline}</div>}
          </div>
        </div>
        <h1 style={{ fontSize: '1.5rem' }}>{title}</h1>
        {children}
        <p className="small muted" style={{ marginTop: '1.4rem', marginBottom: 0 }}>{brand?.companyName}</p>
      </div>
    </div>
  );
}
