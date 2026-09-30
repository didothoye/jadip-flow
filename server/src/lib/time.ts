import { config } from '../config.js';

/** Heure locale « HH:MM » dans le fuseau de l'application. */
export function localHHMM(d = new Date(), tz = config.timezone): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** Vrai si l'heure courante tombe dans la plage [start, end[ (qui peut passer minuit). */
export function inWindow(now: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Prochain instant où l'heure locale vaut `hhmm` (précision minute). */
export function nextLocalTime(hhmm: string, from = new Date(), tz = config.timezone): Date {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 24 * 60 + 1; i++) {
    d.setTime(d.getTime() + 60000);
    if (localHHMM(d, tz) === hhmm) return d;
  }
  return d;
}

export const fmtDateTime = (d: Date | string | null | undefined, tz = config.timezone) =>
  d ? new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : '—';

export const fmtNumber = (n: number, digits = 0) =>
  new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export const fmtUsd = (n: number) => `${fmtNumber(n, 2)} $US`;

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${fmtNumber(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

/** Bornes UTC d'un mois « AAAA-MM » dans le fuseau de l'application (approximation : décalage fixe du fuseau). */
export function periodBounds(period: string): { from: Date; to: Date } {
  const [y, m] = period.split('-').map(Number);
  const offset = tzOffsetMinutes(new Date(Date.UTC(y, m - 1, 15)));
  const from = new Date(Date.UTC(y, m - 1, 1) - offset * 60000);
  const to = new Date(Date.UTC(y, m, 1) - offset * 60000);
  return { from, to };
}

export function tzOffsetMinutes(d: Date, tz = config.timezone): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

export function previousPeriod(d = new Date()): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function currentPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
