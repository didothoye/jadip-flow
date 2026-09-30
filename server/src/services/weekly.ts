import { config } from '../config.js';
import { q } from '../db.js';
import { fmtDuration, fmtNumber } from '../lib/time.js';
import { enqueue } from './notify.js';

/** Résumé hebdomadaire envoyé aux utilisateurs clients qui l'ont demandé. */
export async function sendWeeklySummaries() {
  const users = await q<any>(`SELECT u.id, u.email, u.name, u.client_id, u.notify_email, u.notify_telegram, u.telegram_chat_id, c.name client_name
    FROM users u JOIN clients c ON c.id=u.client_id WHERE u.role='client' AND u.notify_weekly_summary AND u.disabled_at IS NULL AND u.password_hash IS NOT NULL AND c.archived_at IS NULL`);
  let sent = 0;
  for (const u of users) {
    const [s] = await q<any>(`
      SELECT count(*)::int total, count(*) FILTER (WHERE e.status='success')::int ok, count(*) FILTER (WHERE e.status IN ('error','crashed'))::int ko,
        COALESCE(sum(w.minutes_saved_per_execution) FILTER (WHERE e.status='success'),0)::float minutes
      FROM executions e JOIN workflows w ON w.id=e.workflow_id
      WHERE e.client_id=$1 AND w.client_visible AND e.started_at >= now() - interval '7 days'`, [u.client_id]);
    const rate = s.ok + s.ko ? Math.round((s.ok / (s.ok + s.ko)) * 100) : null;
    const body = `Bonjour ${u.name},\n\nVoici la semaine de vos automatisations (${u.client_name}) :\n` +
      `• ${fmtNumber(s.total)} passage(s), ${rate === null ? 'aucun terminé' : `${rate} % réussis`}\n` +
      `• ${fmtNumber(s.ko)} incident(s)\n• temps gagné estimé : ${fmtDuration(s.minutes)}\n\nDétails : ${config.publicUrl}/portail\n\n${config.brand.companyName}`;
    if (u.notify_email) await enqueue({ channel: 'email', recipient: u.email, subject: `Votre semaine avec ${config.brand.productName}`, body });
    if (u.notify_telegram && u.telegram_chat_id) await enqueue({ channel: 'telegram', recipient: u.telegram_chat_id, body });
    sent++;
  }
  return { sent };
}
