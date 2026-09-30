const TZ = 'Africa/Kinshasa';

export const fmtNum = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export const fmtPct = (v: number | null | undefined, digits = 0) => (v == null ? '—' : `${fmtNum(v * 100, digits)} %`);

export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : `${fmtNum(n, 2)} $US`);

export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, dateStyle: 'medium' }).format(new Date(d)) : '—';

export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : '—';

export const fmtDay = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${iso}T00:00:00Z`));

export function fmtDuration(minutes: number | null | undefined) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${fmtNum(Math.round(minutes))} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${fmtNum(h)} h ${String(m).padStart(2, '0')}` : `${fmtNum(h)} h`;
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${fmtNum(ms / 1000, 1)} s`;
  return fmtDuration(ms / 60000);
}

/** « il y a 3 h », « il y a 2 jours » */
export function fromNow(d: string | Date | null | undefined) {
  if (!d) return 'jamais';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });
  if (Math.abs(s) < 60) return 'à l’instant';
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (Math.abs(s) < 86400 * 45) return rtf.format(-Math.round(s / 86400), 'day');
  return fmtDate(d);
}

export const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Authentification', rate_limit: 'Limite de débit', network: 'Réseau', data: 'Données', logic: 'Logique',
};

export const STATUS_LABELS: Record<string, string> = {
  success: 'Réussie', error: 'Échec', crashed: 'Plantage', running: 'En cours', waiting: 'En attente', canceled: 'Annulée', new: 'Nouvelle',
};

export const TICKET_KIND: Record<string, string> = { change: 'Demande de modification', problem: 'Signalement de problème', question: 'Question' };
export const TICKET_STATUS: Record<string, string> = { new: 'Nouveau', in_progress: 'En cours', waiting_client: 'En attente de réponse', done: 'Terminé', closed: 'Fermé' };

export function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function periodLabel(p: string) {
  const [y, m] = p.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}
