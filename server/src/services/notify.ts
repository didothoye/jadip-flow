import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { one, pool, q, type Queryable } from '../db.js';
import { getSettings, telegramEnabledFor } from './settings.js';
import { getTelegramConfig, sendTelegram } from './telegram.js';
import { inWindow, localHHMM, nextLocalTime } from '../lib/time.js';

export interface Attachment { filename: string; path: string }

async function quietUntil(bypass: boolean): Promise<Date> {
  if (bypass) return new Date();
  const s = await getSettings();
  if (s.quietHours.enabled && inWindow(localHHMM(), s.quietHours.start, s.quietHours.end)) {
    return nextLocalTime(s.quietHours.end);
  }
  return new Date();
}

/** Met un message en file d'attente ; il sera différé s'il tombe pendant les horaires calmes. */
export async function enqueue(msg: { channel: 'telegram' | 'email'; recipient: string; subject?: string; body: string; attachments?: Attachment[]; bypassQuiet?: boolean }, db: Queryable = pool) {
  if (!msg.recipient) return;
  const notBefore = await quietUntil(!!msg.bypassQuiet);
  await db.query(
    `INSERT INTO outbox(channel, recipient, subject, body, attachments, bypass_quiet, not_before) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [msg.channel, msg.recipient, msg.subject ?? null, msg.body, JSON.stringify(msg.attachments ?? []), !!msg.bypassQuiet, notBefore],
  );
}

/** Notification dans l'application (user_id NULL = tous les administrateurs). */
export async function notifyInApp(n: { userId?: string | null; clientId?: string | null; title: string; body: string; link?: string }, db: Queryable = pool) {
  await db.query('INSERT INTO notifications(user_id, client_id, title, body, link) VALUES ($1,$2,$3,$4,$5)',
    [n.userId ?? null, n.clientId ?? null, n.title, n.body, n.link ?? null]);
}

/**
 * Prévient l'agence par les canaux choisis.
 * `kind` (voir alert-types.ts) décide si le message part aussi sur Telegram, selon les interrupteurs de Paramètres › Alertes Telegram.
 */
export async function notifyAdmins(n: { kind: string; title: string; body: string; link?: string; channels?: string[]; clientId?: string | null; bypassQuiet?: boolean }) {
  const channels = n.channels ?? ['app', 'telegram'];
  if (channels.includes('app')) await notifyInApp({ title: n.title, body: n.body, link: n.link, clientId: n.clientId });
  const link = n.link ? `\n${config.publicUrl}${n.link}` : '';
  if (channels.includes('telegram') && await telegramEnabledFor(n.kind)) {
    const tg = await getTelegramConfig();
    if (tg.chatId) await enqueue({ channel: 'telegram', recipient: tg.chatId, body: `<b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}${link}`, bypassQuiet: n.bypassQuiet });
  }
  if (channels.includes('email')) {
    const admins = await q<{ email: string }>(`SELECT email FROM users WHERE role='admin' AND disabled_at IS NULL AND notify_email`);
    const recipients = new Set([config.adminEmail, ...admins.map((a) => a.email)].filter(Boolean));
    for (const r of recipients) await enqueue({ channel: 'email', recipient: r, subject: n.title, body: `${n.body}${link}`, bypassQuiet: n.bypassQuiet });
  }
}

/** Prévient les utilisateurs d'un client selon leurs préférences. */
export async function notifyClientUsers(clientId: string, n: { title: string; body: string; link?: string; kind: 'error' | 'info' }) {
  const users = await q<any>(`SELECT id, email, telegram_chat_id, notify_email, notify_telegram, notify_on_error FROM users WHERE client_id=$1 AND disabled_at IS NULL AND password_hash IS NOT NULL`, [clientId]);
  const link = n.link ? `\n${config.publicUrl}${n.link}` : '';
  for (const u of users) {
    await notifyInApp({ userId: u.id, clientId, title: n.title, body: n.body, link: n.link });
    if (n.kind === 'error' && !u.notify_on_error) continue;
    if (u.notify_email) await enqueue({ channel: 'email', recipient: u.email, subject: n.title, body: `${n.body}${link}` });
    if (u.notify_telegram && u.telegram_chat_id) await enqueue({ channel: 'telegram', recipient: u.telegram_chat_id, body: `<b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}${link}` });
  }
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function mailer() {
  if (!config.smtp.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

export async function sendEmailNow(to: string, subject: string, text: string, attachments: Attachment[] = []) {
  const t = mailer();
  if (!t) throw new Error('SMTP non configuré');
  const brand = config.brand;
  const html = `<div style="font-family:'Times New Roman',serif;font-size:12pt;color:#111">
    <div style="border-bottom:1px solid #999;padding-bottom:6px;margin-bottom:12px"><strong>${escapeHtml(brand.companyName)}</strong> — ${escapeHtml(brand.productName)}</div>
    ${escapeHtml(text).replace(/\n/g, '<br>')}
    <div style="border-top:1px solid #ccc;margin-top:18px;padding-top:6px;color:#555;font-size:10pt">${escapeHtml(brand.companyName)} · ${escapeHtml(brand.supportEmail)}</div></div>`;
  await t.sendMail({ from: config.smtp.from, to, subject, text, html, attachments });
}

/** Envoi Telegram immédiat avec le compte enregistré dans Paramètres (jamais de jeton dans les erreurs). */
export const sendTelegramNow = (chatId: string, html: string) => sendTelegram(chatId, html);

/** Envoie les messages en attente dont l'heure est venue. */
export async function flushOutbox(limit = 50): Promise<number> {
  const rows = await q<any>(`SELECT * FROM outbox WHERE status='pending' AND not_before <= now() ORDER BY id LIMIT $1`, [limit]);
  let sent = 0;
  for (const m of rows) {
    try {
      if (m.channel === 'telegram') await sendTelegramNow(m.recipient, m.body);
      else await sendEmailNow(m.recipient, m.subject ?? config.brand.productName, m.body, m.attachments ?? []);
      await q(`UPDATE outbox SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [m.id]);
      sent++;
    } catch (e: any) {
      const attempts = m.attempts + 1;
      await q(`UPDATE outbox SET attempts=$2, last_error=$3, status=CASE WHEN $2 >= 5 THEN 'failed' ELSE 'pending' END,
               not_before = now() + ($2 * interval '5 minutes') WHERE id=$1`, [m.id, attempts, String(e.message).slice(0, 500)]);
    }
  }
  return sent;
}

export async function unreadCount(userId: string, isAdmin: boolean) {
  const r = await one<{ n: number }>(
    isAdmin ? `SELECT count(*)::int n FROM notifications WHERE (user_id=$1 OR user_id IS NULL) AND read_at IS NULL`
            : `SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [userId]);
  return r?.n ?? 0;
}
