import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db.js';
import { audit, verifyAuditChain } from '../../audit.js';
import { createApiToken, requireAdmin, requireUser } from '../../auth.js';
import { encrypt, randomToken } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { idParam, parse, z } from '../../lib/validate.js';
import { WEBHOOK_EVENTS } from '../../services/webhooks.js';

export default async function systemRoutes(app: FastifyInstance) {
  // --- journal d'audit
  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ before: z.coerce.number().int().optional(), action: z.string().max(80).optional(), source: z.string().max(20).optional(), client_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return q(`SELECT id, at, actor_label, source, action, target_type, target_id, client_id, ip, detail, hash FROM audit_log
              WHERE ($1::bigint IS NULL OR id < $1) AND ($2::text IS NULL OR action LIKE $2 || '%') AND ($3::text IS NULL OR source=$3) AND ($4::uuid IS NULL OR client_id=$4)
              ORDER BY id DESC LIMIT $5`, [f.before ?? null, f.action ?? null, f.source ?? null, f.client_id ?? null, f.limit]);
  });

  app.get('/api/admin/audit/verify', async (req) => {
    requireAdmin(req);
    return verifyAuditChain();
  });

  // --- jetons d'API (chaque utilisateur gère les siens ; les jetons client sont cloisonnés à leur client)
  app.get('/api/tokens', async (req) => {
    const a = requireUser(req);
    return q(`SELECT id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC`, [a.userId]);
  });

  app.post('/api/tokens', async (req, reply) => {
    const a = requireUser(req);
    const b = parse(z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(['read', 'write'])).min(1).default(['read']), expires_in_days: z.number().int().min(1).max(3650).nullable().optional() }), req.body);
    const exp = b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86400000) : null;
    const t = await createApiToken(a.userId, b.name, b.scopes, exp);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'api_token.created', targetType: 'api_token', targetId: t.id, clientId: a.clientId, ip: req.ip, detail: { name: b.name, scopes: b.scopes } });
    reply.code(201);
    return { id: t.id, token: t.token, message: 'Copiez ce jeton maintenant : il ne sera plus jamais affiché.' };
  });

  app.delete('/api/tokens/:id', async (req) => {
    const a = requireUser(req);
    const { id } = parse(idParam, req.params);
    const r = await one('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [id, a.userId]);
    if (!r) throw notFound('Jeton');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'api_token.revoked', targetType: 'api_token', targetId: id, clientId: a.clientId, ip: req.ip });
    return { ok: true };
  });

  // --- webhooks sortants
  app.get('/api/admin/webhooks', async (req) => {
    requireAdmin(req);
    const hooks = await q(`SELECT h.id, h.name, h.url, h.events, h.client_id, c.name client_name, h.enabled, h.created_at,
      (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id=h.id AND d.status='failed') failed,
      (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.webhook_id=h.id) last_delivered_at
      FROM webhooks h LEFT JOIN clients c ON c.id=h.client_id ORDER BY h.name`);
    return { hooks, events: WEBHOOK_EVENTS };
  });

  app.post('/api/admin/webhooks', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ name: z.string().min(1).max(100), url: z.string().url().startsWith('https://', 'URL https:// requise'), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), client_id: z.string().uuid().nullable().optional() }), req.body);
    const secret = randomToken(24);
    const h = await one<any>(`INSERT INTO webhooks(name, url, secret_enc, events, client_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, url, events, client_id, enabled`,
      [b.name, b.url, encrypt(secret), b.events, b.client_id ?? null]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'webhook.created', targetType: 'webhook', targetId: h.id, ip: req.ip, detail: { name: b.name, url: b.url, events: b.events } });
    reply.code(201);
    return { ...h, secret, message: 'Conservez ce secret de signature : il ne sera plus affiché.' };
  });

  app.patch('/api/admin/webhooks/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ enabled: z.boolean().optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(), name: z.string().min(1).max(100).optional() }), req.body);
    const h = await one(`UPDATE webhooks SET enabled=COALESCE($2,enabled), events=COALESCE($3,events), name=COALESCE($4,name) WHERE id=$1 RETURNING id`, [id, b.enabled ?? null, b.events ?? null, b.name ?? null]);
    if (!h) throw notFound('Webhook');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'webhook.updated', targetType: 'webhook', targetId: id, ip: req.ip, detail: b });
    return { ok: true };
  });

  app.delete('/api/admin/webhooks/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (!(await one('DELETE FROM webhooks WHERE id=$1 RETURNING id', [id]))) throw notFound('Webhook');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'webhook.deleted', targetType: 'webhook', targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/webhooks/:id/deliveries', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    return q(`SELECT id, event, status, attempts, response_code, last_error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT 100`, [id]);
  });

  app.get('/api/admin/jobs', async (req) => {
    requireAdmin(req);
    const [jobs, outbox] = await Promise.all([
      q('SELECT * FROM job_runs ORDER BY name'),
      q(`SELECT status, channel, count(*)::int n FROM outbox WHERE created_at > now() - interval '7 days' GROUP BY 1,2`),
    ]);
    return { jobs, outbox };
  });
}
