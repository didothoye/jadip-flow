import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { audit } from '../audit.js';
import {
  consumeUserToken, createSession, createUserToken, destroySession, hashPassword, requireUser, validatePassword, verifyPassword,
} from '../auth.js';
import { decrypt, encrypt, sha256 } from '../lib/crypto.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { enqueue } from '../services/notify.js';

authenticator.options = { window: 1 };

const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };

export async function publicUser(userId: string) {
  return one<any>(`
    SELECT u.id, u.email, u.name, u.role, u.client_id, u.totp_enabled, u.telegram_chat_id, u.notify_email, u.notify_telegram,
           u.notify_on_error, u.notify_weekly_summary, c.name client_name, c.code client_code, c.show_costs, c.show_reports,
           c.can_toggle, c.can_retry, c.logo_path client_logo
    FROM users u LEFT JOIN clients c ON c.id=u.client_id WHERE u.id=$1`, [userId]);
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/brand', async () => config.brand);

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const u = await one<any>('SELECT * FROM users WHERE email=$1 AND disabled_at IS NULL', [b.email]);
    const ok = u?.password_hash ? await verifyPassword(u.password_hash, b.password) : false;
    await audit({ actorUserId: u?.id ?? null, actorLabel: b.email, source: 'web', action: ok ? 'auth.login' : 'auth.login_failed', ip: req.ip });
    if (!ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'invalid_credentials');
    await createSession(reply, req, u.id, u.totp_enabled);
    if (u.totp_enabled) return { mfaRequired: true };
    await q('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    return { mfaRequired: false, user: await publicUser(u.id) };
  });

  app.post('/api/auth/mfa', loginLimit, async (req) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!req.sessionId || !req.mfaPending) throw new HttpError(401, 'Session expirée, reconnectez-vous.', 'unauthorized');
    const s = await one<any>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1', [req.sessionId]);
    if (!s?.totp_secret_enc || !authenticator.check(b.code, decrypt(s.totp_secret_enc))) {
      await audit({ actorUserId: s?.id, actorLabel: s?.email, source: 'web', action: 'auth.mfa_failed', ip: req.ip });
      throw new HttpError(401, 'Code incorrect.', 'invalid_code');
    }
    await q('UPDATE sessions SET mfa_pending=false WHERE id=$1', [req.sessionId]);
    await q('UPDATE users SET last_login_at=now() WHERE id=$1', [s.id]);
    return { user: await publicUser(s.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.actor) return { user: null, mfaRequired: req.mfaPending };
    return { user: await publicUser(req.actor.userId) };
  });

  // --- invitation / activation
  app.get('/api/auth/invite/:token', async (req) => {
    const { token } = req.params as { token: string };
    const r = await one<any>(`SELECT u.email, u.name FROM user_tokens t JOIN users u ON u.id=t.user_id
                              WHERE t.token_hash=$1 AND t.kind='invite' AND t.used_at IS NULL AND t.expires_at > now()`, [sha256(token)]);
    if (!r) throw new HttpError(410, 'Ce lien d’activation a expiré ou a déjà été utilisé.', 'expired');
    return r;
  });

  app.post('/api/auth/activate', loginLimit, async (req, reply) => {
    const b = parse(z.object({ token: z.string().min(10), password: z.string() }), req.body);
    const err = validatePassword(b.password);
    if (err) throw badRequest(err);
    const userId = await consumeUserToken(b.token, 'invite');
    if (!userId) throw new HttpError(410, 'Ce lien d’activation a expiré ou a déjà été utilisé.', 'expired');
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await hashPassword(b.password)]);
    await audit({ actorUserId: userId, source: 'web', action: 'auth.activated', ip: req.ip });
    await createSession(reply, req, userId, false);
    return { user: await publicUser(userId) };
  });

  app.post('/api/auth/forgot', loginLimit, async (req) => {
    const b = parse(z.object({ email: z.string().email() }), req.body);
    const u = await one<any>('SELECT id, email, name FROM users WHERE email=$1 AND disabled_at IS NULL AND password_hash IS NOT NULL', [b.email]);
    if (u) {
      const token = await createUserToken(u.id, 'reset', 2);
      await enqueue({ channel: 'email', recipient: u.email, bypassQuiet: true, subject: `${config.brand.productName} — réinitialisation du mot de passe`,
        body: `Bonjour ${u.name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 2 heures) :\n${config.publicUrl}/reinitialiser/${token}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.` });
      await audit({ actorUserId: u.id, actorLabel: u.email, source: 'web', action: 'auth.reset_requested', ip: req.ip });
    }
    return { ok: true }; // réponse identique pour ne pas révéler l'existence du compte
  });

  app.post('/api/auth/reset', loginLimit, async (req) => {
    const b = parse(z.object({ token: z.string().min(10), password: z.string() }), req.body);
    const err = validatePassword(b.password);
    if (err) throw badRequest(err);
    const userId = await consumeUserToken(b.token, 'reset');
    if (!userId) throw new HttpError(410, 'Ce lien a expiré ou a déjà été utilisé.', 'expired');
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await hashPassword(b.password)]);
    await q('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await audit({ actorUserId: userId, source: 'web', action: 'auth.password_reset', ip: req.ip });
    return { ok: true };
  });

  // --- profil
  app.patch('/api/me', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({
      name: z.string().min(1).max(120).optional(),
      notify_email: z.boolean().optional(), notify_telegram: z.boolean().optional(),
      notify_on_error: z.boolean().optional(), notify_weekly_summary: z.boolean().optional(),
      telegram_chat_id: z.string().regex(/^-?\d{3,20}$/, 'identifiant Telegram numérique attendu').nullable().optional(),
    }), req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (keys.length) {
      await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [a.userId, ...keys.map((k) => b[k])]);
      await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'user.preferences_updated', clientId: a.clientId, ip: req.ip, detail: b });
    }
    return { user: await publicUser(a.userId) };
  });

  app.post('/api/me/password', loginLimit, async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ current: z.string(), password: z.string() }), req.body);
    const u = await one<any>('SELECT password_hash FROM users WHERE id=$1', [a.userId]);
    if (!u?.password_hash || !(await verifyPassword(u.password_hash, b.current))) throw new HttpError(401, 'Mot de passe actuel incorrect.', 'invalid_credentials');
    const err = validatePassword(b.password);
    if (err) throw badRequest(err);
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [a.userId, await hashPassword(b.password)]);
    await q('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [a.userId, req.sessionId]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: 'web', action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });

  // --- double authentification (TOTP)
  app.post('/api/me/totp/setup', async (req) => {
    const a = requireUser(req);
    const secret = authenticator.generateSecret();
    await q('UPDATE users SET totp_secret_enc=$2 WHERE id=$1 AND NOT totp_enabled', [a.userId, encrypt(secret)]);
    const uri = authenticator.keyuri(a.label, config.brand.productName, secret);
    return { secret, uri, qr: await QRCode.toDataURL(uri) };
  });

  app.post('/api/me/totp/enable', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = await one<any>('SELECT totp_secret_enc FROM users WHERE id=$1', [a.userId]);
    if (!u?.totp_secret_enc || !authenticator.check(b.code, decrypt(u.totp_secret_enc))) throw badRequest('Code incorrect.');
    await q('UPDATE users SET totp_enabled=true WHERE id=$1', [a.userId]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: 'web', action: 'auth.totp_enabled', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/me/totp/disable', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ password: z.string() }), req.body);
    const u = await one<any>('SELECT password_hash FROM users WHERE id=$1', [a.userId]);
    if (!u?.password_hash || !(await verifyPassword(u.password_hash, b.password))) throw new HttpError(401, 'Mot de passe incorrect.', 'invalid_credentials');
    await q('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL WHERE id=$1', [a.userId]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: 'web', action: 'auth.totp_disabled', ip: req.ip });
    return { ok: true };
  });

  // --- notifications dans l'application
  app.get('/api/notifications', async (req) => {
    const a = requireUser(req);
    const cond = a.role === 'admin' ? '(user_id=$1 OR user_id IS NULL)' : 'user_id=$1';
    const items = await q(`SELECT id, title, body, link, read_at, created_at FROM notifications WHERE ${cond} ORDER BY id DESC LIMIT 50`, [a.userId]);
    const unread = await one<{ n: number }>(`SELECT count(*)::int n FROM notifications WHERE ${cond} AND read_at IS NULL`, [a.userId]);
    return { items, unread: unread?.n ?? 0 };
  });

  app.post('/api/notifications/read', async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ ids: z.array(z.number().int()).optional() }), req.body);
    const cond = a.role === 'admin' ? '(user_id=$1 OR user_id IS NULL)' : 'user_id=$1';
    if (b.ids?.length) await q(`UPDATE notifications SET read_at=now() WHERE ${cond} AND id = ANY($2) AND read_at IS NULL`, [a.userId, b.ids]);
    else await q(`UPDATE notifications SET read_at=now() WHERE ${cond} AND read_at IS NULL`, [a.userId]);
    return { ok: true };
  });
}
