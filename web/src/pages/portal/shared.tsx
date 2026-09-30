import { useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { fmtNum, TICKET_STATUS } from '../../lib/format';
import { Badge, Modal, Switch, useAction, useUi } from '../../components/ui';
import './portal.css';

/** Carte d'automatisation telle que renvoyée par l'API du portail. */
export interface WfCard {
  id: string; name: string; description: string | null; active: boolean; paused_until: string | null;
  last_execution_at: string | null; last_status: string | null; success_rate_30d: number | null; executions_30d: number;
  failures_30d: number; minutes_saved_month: number; locked: boolean; can_toggle: boolean; can_retry: boolean;
}

const TZ = 'Africa/Kinshasa';

/** « mercredi 1 octobre à 14:00 » (l'année seulement si elle diffère). */
export function fmtUntil(d: string) {
  const date = new Date(d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(date);
  return `${day} à ${time}`;
}

/** « jusqu’à 21:34 », « jusqu’à demain 21:34 », « jusqu’au mercredi 7 octobre à 21:34 ». */
export function untilPhrase(d: string) {
  const day = (x: Date) => new Intl.DateTimeFormat('fr-CA', { timeZone: TZ }).format(x);
  const date = new Date(d);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(date);
  if (day(date) === day(new Date())) return `jusqu’à ${time}`;
  if (day(date) === day(new Date(Date.now() + 86400000))) return `jusqu’à demain ${time}`;
  return `jusqu’au ${fmtUntil(d)}`;
}

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const rateTone = (r: number | null | undefined): 'good' | 'warn' | 'bad' | undefined =>
  r == null ? undefined : r >= 0.9 ? 'good' : r >= 0.75 ? 'warn' : 'bad';

/** Version courte de « il y a… » pour les cartes : « il y a 49 min », « il y a 8 h », « il y a 3 j ». */
export function shortAgo(d: string | null) {
  if (!d) return 'jamais';
  const m = (Date.now() - new Date(d).getTime()) / 60000;
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${Math.round(m)} min`;
  if (m < 60 * 24) return `il y a ${Math.round(m / 60)} h`;
  if (m < 60 * 24 * 45) return `il y a ${Math.round(m / 1440)} j`;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(d));
}

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${fmtNum(bytes / 1024, 0)} Ko`;
  return `${fmtNum(bytes / 1024 / 1024, 1)} Mo`;
}

/** Libellé de la phrase d'état (active, en pause jusqu'au…, désactivée). */
export function stateOf(w: Pick<WfCard, 'active' | 'paused_until'>): { cls: 'on' | 'paused' | 'off'; label: string } {
  if (w.active) return { cls: 'on', label: 'Active' };
  if (w.paused_until && new Date(w.paused_until).getTime() > Date.now()) return { cls: 'paused', label: `En pause ${untilPhrase(w.paused_until)}` };
  return { cls: 'off', label: 'Désactivée' };
}

export function WfState({ w }: { w: Pick<WfCard, 'active' | 'paused_until'> }) {
  const s = stateOf(w);
  return (
    <span className={`state ${s.cls}`}>
      <span className="dot" aria-hidden="true" />{s.label}
    </span>
  );
}

export const LockedTag = () => (
  <span className="p-lock" title="Cette automatisation est essentielle : seule l’équipe Jadip Services peut l’arrêter.">
    <span aria-hidden="true">🔒</span>Gérée par Jadip Services
  </span>
);

/** Phrase expliquant ce qui ne sera plus fait tant que l'automatisation est arrêtée. */
function consequence(w: WfCard) {
  if (!w.description) return 'Tant qu’elle est arrêtée, cette automatisation ne fera plus son travail.';
  const d = w.description.trim().replace(/\.$/, '');
  return <>Tant qu’elle est arrêtée, cette tâche ne sera plus faite automatiquement : <em>« {d[0].toLowerCase() + d.slice(1)} »</em>.</>;
}

const STOP_CHOICES: { key: string; hours: number | null; title: string; desc: string }[] = [
  { key: '1', hours: 1, title: 'Pause d’une heure', desc: 'Elle redémarre toute seule dans une heure.' },
  { key: '24', hours: 24, title: 'Pause de 24 heures', desc: 'Elle redémarre toute seule demain à la même heure.' },
  { key: '168', hours: 168, title: 'Pause de 7 jours', desc: 'Elle redémarre toute seule dans une semaine.' },
  { key: 'off', hours: null, title: 'Désactiver jusqu’à nouvel ordre', desc: 'Elle reste arrêtée jusqu’à ce que vous la réactiviez.' },
];

/**
 * Commandes marche/arrêt d'une automatisation, avec confirmation en langage clair.
 * Renvoie la fonction à appeler et la boîte de dialogue à afficher.
 */
export function useWorkflowControls(onDone: () => void) {
  const { confirm } = useUi();
  const { run, busy } = useAction();
  const [stopping, setStopping] = useState<WfCard | null>(null);
  const [choice, setChoice] = useState('24');

  const change = async (w: WfCard, wantActive: boolean) => {
    if (busy) return;
    if (wantActive) {
      const r = await confirm({
        title: `Réactiver « ${w.name} » ?`,
        message: <p style={{ margin: 0 }}>L’automatisation reprendra son travail immédiatement{w.description ? <> : <em>« {w.description.trim().replace(/\.$/, '')} »</em></> : ''}.</p>,
        confirmLabel: 'Réactiver',
      });
      if (!r.ok) return;
      const ok = await run(() => api.post(`/api/portal/workflows/${w.id}/activate`), `« ${w.name} » est de nouveau active.`);
      if (ok) onDone();
      return;
    }
    setChoice('24');
    setStopping(w);
  };

  const doStop = async () => {
    const w = stopping!;
    const c = STOP_CHOICES.find((x) => x.key === choice)!;
    setStopping(null);
    const ok = c.hours
      ? await run(() => api.post(`/api/portal/workflows/${w.id}/pause`, { hours: c.hours }), `« ${w.name} » est en pause. Elle redémarrera automatiquement.`)
      : await run(() => api.post(`/api/portal/workflows/${w.id}/deactivate`), `« ${w.name} » est désactivée.`);
    if (ok) onDone();
  };

  const dialog = stopping ? (
    <Modal title={`Arrêter « ${stopping.name} » ?`} onClose={() => setStopping(null)} actions={<>
      <button className="btn" onClick={() => setStopping(null)}>Annuler</button>
      <button className="btn danger solid" onClick={doStop} autoFocus>{choice === 'off' ? 'Désactiver' : 'Mettre en pause'}</button>
    </>}>
      <p>{consequence(stopping)}</p>
      <p className="muted small" style={{ marginBottom: 0 }}>Rien n’est perdu : vous pourrez la réactiver à tout moment d’un simple geste.</p>
      <fieldset className="p-choices" style={{ border: 0, padding: 0 }}>
        <legend className="sr-only">Durée de l’arrêt</legend>
        {STOP_CHOICES.map((c) => (
          <label key={c.key} className={`p-choice ${choice === c.key ? 'sel' : ''}`}>
            <input type="radio" name="stop" value={c.key} checked={choice === c.key} onChange={() => setChoice(c.key)} />
            <span><span className="ct">{c.title}</span><br /><span className="cd">{c.desc}</span></span>
          </label>
        ))}
      </fieldset>
    </Modal>
  ) : null;

  return { change, dialog, busy };
}

/** Interrupteur marche/arrêt (ou mention « Gérée par Jadip Services »). */
export function WfToggle({ w, onChange, busy }: { w: WfCard; onChange: (w: WfCard, v: boolean) => void; busy?: boolean }) {
  if (w.locked) return <LockedTag />;
  if (!w.can_toggle) return null;
  return (
    <span className="p-tap">
      <span className="switch big">
        <Switch checked={w.active} disabled={busy} onChange={(v) => onChange(w, v)} label={w.active ? `Arrêter « ${w.name} »` : `Réactiver « ${w.name} »`} />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- demandes

export const TICKET_STATUS_CLIENT: Record<string, string> = { ...TICKET_STATUS, waiting_client: 'En attente de votre réponse' };
const TICKET_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | undefined> = { new: 'info', in_progress: 'info', waiting_client: 'warn', done: 'good', closed: undefined };
export const TicketBadge = ({ status }: { status: string }) => <Badge tone={TICKET_TONE[status]}>{TICKET_STATUS_CLIENT[status] ?? status}</Badge>;

export const KIND_ICON: Record<string, string> = { change: '✏️', problem: '⚠️', question: '💬' };

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const OK_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|csv|docx?|xlsx?)$/i;

/** Sélection de pièces jointes : liste des fichiers choisis, retrait, contrôles de taille et de nombre. */
export function FilePicker({ files, setFiles, disabled }: { files: File[]; setFiles: (f: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (!OK_EXT.test(f.name)) { problems.push(`« ${f.name} » : ce type de fichier n’est pas accepté.`); continue; }
      if (f.size > MAX_BYTES) { problems.push(`« ${f.name} » dépasse 10 Mo.`); continue; }
      if (next.length >= MAX_FILES) { problems.push(`${MAX_FILES} fichiers maximum.`); break; }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setErr(problems.length ? problems.join(' ') : null);
    setFiles(next);
    if (ref.current) ref.current.value = '';
  };
  return (
    <div>
      <div className="p-drop">
        <button type="button" className="btn" onClick={() => ref.current?.click()} disabled={disabled || files.length >= MAX_FILES}>
          <span aria-hidden="true">📎</span> Joindre des fichiers
        </button>
        <span className="small muted">Photos, captures d’écran, PDF, Word, Excel ou texte · {MAX_FILES} fichiers de 10 Mo maximum</span>
        <input ref={ref} type="file" multiple accept={ACCEPT} hidden onChange={(e) => add(e.target.files)} aria-label="Joindre des fichiers" />
      </div>
      {err && <div className="small" role="alert" style={{ color: 'var(--bad)', marginTop: '.4rem' }}>{err}</div>}
      {files.length > 0 && (
        <ul className="p-files" aria-label="Fichiers joints">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span aria-hidden="true">{f.type.startsWith('image/') ? '🖼️' : '📄'}</span>
              <span className="fn">{f.name}</span>
              <span className="small muted nowrap">{fmtSize(f.size)}</span>
              <button type="button" className="btn ghost small" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Retirer ${f.name}`} disabled={disabled}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Message d'accès refusé lorsqu'une rubrique n'est pas activée pour ce compte. */
export function NotAvailable({ children }: { children: ReactNode }) {
  return <div className="card"><div className="empty">{children}</div></div>;
}
