import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { config } from './config.js';
import { one, q } from './db.js';
import { randomToken, sha256 } from './lib/crypto.js';
import type { Actor } from './lib/actor.js';
import { HttpError } from './lib/errors.js';

export const SESSION_COOKIE = 'jf_session';
const SESSION_DAYS = 14;

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    sessionId: string | null;
    mfaPending: boolean;
  }
}

export const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);

export function validatePassword(p: string): string | null {
  if (typeof p !== 'string' || p.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Le mot de passe doit contenir des lettres et des chiffres.';
  return null;
}

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string, mfaPending: boolean) {
  const token = randomToken(32);
  await q(`INSERT INTO sessions(id, user_id, mfa_pending, expires_at, ip, user_agent) VALUES ($1,$2,$3, now() + ($4 * interval '1 day'), $5, $6)`,
    [sha256(token), userId, mfaPending, SESSION_DAYS, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) await q('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('mfaPending', false);

  app.addHook('onRequest', async (req) => {
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const tok = authz.slice(7).trim();
      const row = await one<any>(`
        SELECT t.id, t.scopes, u.id user_id, u.role, u.client_id, u.email FROM api_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL`, [sha256(tok)]);
      if (!row) throw new HttpError(401, 'Jeton d’API invalide ou révoqué', 'unauthorized');
      q('UPDATE api_tokens SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [row.id]).catch(() => {});
      req.actor = {
        userId: row.user_id, role: row.role, clientId: row.client_id, label: row.email,
        source: req.url.startsWith('/mcp') ? 'mcp' : 'api', ip: req.ip, scopes: row.scopes,
      };
      return;
    }
    const tok = req.cookies[SESSION_COOKIE];
    if (!tok) return;
    const row = await one<any>(`
      SELECT s.id, s.mfa_pending, u.id user_id, u.role, u.client_id, u.email FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.expires_at > now() AND u.disabled_at IS NULL`, [sha256(tok)]);
    if (!row) return;
    req.sessionId = row.id;
    req.mfaPending = row.mfa_pending;
    if (row.mfa_pending) return;
    req.actor = { userId: row.user_id, role: row.role, clientId: row.client_id, label: row.email, source: 'web', ip: req.ip };
    // protection CSRF : les requêtes mutantes authentifiées par cookie doivent porter l'en-tête applicatif
    if (MUTATING.has(req.method) && req.headers['x-jf-csrf'] !== '1') {
      throw new HttpError(403, 'En-tête anti-CSRF manquant', 'csrf');
    }
  });
}

export function requireUser(req: FastifyRequest): Actor {
  if (!req.actor) throw new HttpError(401, 'Authentification requise', 'unauthorized');
  return req.actor;
}

export function requireAdmin(req: FastifyRequest): Actor {
  const a = requireUser(req);
  if (a.role !== 'admin') throw new HttpError(403, 'Réservé à l’agence', 'forbidden');
  return a;
}

export function requireClient(req: FastifyRequest): Actor & { clientId: string } {
  const a = requireUser(req);
  if (a.role !== 'client' || !a.clientId) throw new HttpError(403, 'Réservé aux comptes clients', 'forbidden');
  return a as Actor & { clientId: string };
}

/** Crée un jeton à usage unique (invitation / réinitialisation). */
export async function createUserToken(userId: string, kind: 'invite' | 'reset', hours: number) {
  const token = randomToken(32);
  await q(`UPDATE user_tokens SET used_at=now() WHERE user_id=$1 AND kind=$2 AND used_at IS NULL`, [userId, kind]);
  await q(`INSERT INTO user_tokens(user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 * interval '1 hour'))`, [userId, kind, sha256(token), hours]);
  return token;
}

export async function consumeUserToken(token: string, kind: 'invite' | 'reset'): Promise<string | null> {
  const r = await one<{ user_id: string }>(
    `UPDATE user_tokens SET used_at=now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(token), kind]);
  return r?.user_id ?? null;
}

export async function createApiToken(userId: string, name: string, scopes: string[], expiresAt: Date | null) {
  const token = `jf_${randomToken(30)}`;
  const row = await one<{ id: string }>(`INSERT INTO api_tokens(user_id, name, prefix, token_hash, scopes, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, name, token.slice(0, 7), sha256(token), scopes, expiresAt]);
  return { id: row!.id, token };
}
