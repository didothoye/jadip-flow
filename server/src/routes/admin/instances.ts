import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db.js';
import { audit } from '../../audit.js';
import { requireAdmin } from '../../auth.js';
import { decrypt, encrypt, maskSecret } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { idParam, parse, z } from '../../lib/validate.js';
import { N8nClient } from '../../n8n/client.js';
import { checkHealth, syncInstance } from '../../services/sync.js';

const url = z.string().url().refine((u) => /^https?:\/\//.test(u), 'URL http(s) attendue');
const instanceBody = z.object({
  name: z.string().min(1).max(100),
  base_url: url,
  public_url: url.nullable().optional(),
  api_key: z.string().min(10).optional(),
  sync_enabled: z.boolean().optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
  retention_days: z.number().int().min(1).max(3650).optional(),
});

const COLS = `id, name, base_url, public_url, sync_enabled, sync_interval_minutes, retention_days, health_status, health_message, health_checked_at,
  last_sync_at, last_sync_status, consecutive_sync_failures, created_at, api_key_enc`;

function present(i: any) {
  const { api_key_enc, ...rest } = i;
  let hint = '••••';
  try { hint = maskSecret(decrypt(api_key_enc)); } catch { /* clé illisible */ }
  return { ...rest, api_key_hint: hint };
}

export default async function instanceRoutes(app: FastifyInstance) {
  app.get('/api/admin/instances', async (req) => {
    requireAdmin(req);
    const rows = await q<any>(`SELECT ${COLS},
      (SELECT count(*)::int FROM workflows w WHERE w.instance_id=i.id AND w.deleted_at IS NULL) workflows,
      (SELECT count(*)::int FROM workflows w WHERE w.instance_id=i.id AND w.deleted_at IS NULL AND w.active) workflows_active,
      (SELECT count(*)::int FROM executions e WHERE e.instance_id=i.id AND e.started_at > now() - interval '24 hours') executions_24h,
      (SELECT array_agg(DISTINCT c.name) FROM workflows w JOIN clients c ON c.id=w.client_id WHERE w.instance_id=i.id AND w.deleted_at IS NULL) clients
      FROM instances i ORDER BY name`);
    return rows.map(present);
  });

  app.get('/api/admin/instances/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const i = await one<any>(`SELECT ${COLS} FROM instances WHERE id=$1`, [id]);
    if (!i) throw notFound('Instance');
    return present(i);
  });

  app.post('/api/admin/instances/test', async (req) => {
    requireAdmin(req);
    const b = parse(z.object({ base_url: url, api_key: z.string().optional(), id: z.string().uuid().optional() }), req.body);
    let key = b.api_key;
    if (!key && b.id) {
      const i = await one<any>('SELECT api_key_enc FROM instances WHERE id=$1', [b.id]);
      if (i) key = decrypt(i.api_key_enc);
    }
    if (!key) return { reachable: false, authOk: false, message: 'Clé API requise' };
    return new N8nClient(b.base_url, key, 10000).health();
  });

  app.post('/api/admin/instances', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(instanceBody.required({ api_key: true }), req.body);
    const i = await one<any>(`INSERT INTO instances(name, base_url, public_url, api_key_enc, sync_enabled, sync_interval_minutes, retention_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
      [b.name, b.base_url, b.public_url ?? null, encrypt(b.api_key), b.sync_enabled ?? true, b.sync_interval_minutes ?? 5, b.retention_days ?? 90]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'instance.created', targetType: 'instance', targetId: i.id, ip: req.ip, detail: { name: b.name, base_url: b.base_url } });
    reply.code(201);
    return present(i);
  });

  app.patch('/api/admin/instances/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(instanceBody.partial(), req.body);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    for (const k of ['name', 'base_url', 'public_url', 'sync_enabled', 'sync_interval_minutes', 'retention_days'] as const) if (b[k] !== undefined) set(k, b[k]);
    if (b.api_key) set('api_key_enc', encrypt(b.api_key));
    if (!sets.length) throw notFound('Modification');
    const i = await one<any>(`UPDATE instances SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING ${COLS}`, vals);
    if (!i) throw notFound('Instance');
    const { api_key, ...safe } = b;
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'instance.updated', targetType: 'instance', targetId: id, ip: req.ip,
      detail: { ...safe, api_key_changed: !!api_key } });
    return present(i);
  });

  app.delete('/api/admin/instances/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const i = await one<any>('DELETE FROM instances WHERE id=$1 RETURNING name', [id]);
    if (!i) throw notFound('Instance');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'instance.deleted', targetType: 'instance', targetId: id, ip: req.ip, detail: { name: i.name } });
    return { ok: true };
  });

  app.post('/api/admin/instances/:id/health', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    return checkHealth(id);
  });

  app.post('/api/admin/instances/:id/sync', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'instance.sync_requested', targetType: 'instance', targetId: id, ip: req.ip });
    return syncInstance(id, 'manual');
  });

  app.get('/api/admin/sync-runs', async (req) => {
    requireAdmin(req);
    const qs = parse(z.object({ instance_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return q(`SELECT r.*, i.name instance_name FROM sync_runs r JOIN instances i ON i.id=r.instance_id
              WHERE ($1::uuid IS NULL OR r.instance_id=$1) ORDER BY r.started_at DESC LIMIT $2`, [qs.instance_id ?? null, qs.limit]);
  });
}
