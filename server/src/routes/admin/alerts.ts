import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db.js';
import { audit } from '../../audit.js';
import { requireAdmin } from '../../auth.js';
import { notFound } from '../../lib/errors.js';
import { idParam, numIdParam, parse, z } from '../../lib/validate.js';
import { getSettings, saveSetting } from '../../services/settings.js';
import { sendEmailNow, sendTelegramNow } from '../../services/notify.js';
import { config } from '../../config.js';

const ruleBody = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['execution_failed', 'workflow_inactive', 'failure_rate', 'sync_failed', 'llm_budget']),
  client_id: z.string().uuid().nullable().optional(),
  workflow_id: z.string().uuid().nullable().optional(),
  threshold: z.number().min(0).nullable().optional(),
  window_hours: z.number().int().min(1).max(24 * 30).optional(),
  group_minutes: z.number().int().min(0).max(1440).optional(),
  repeat_minutes: z.number().int().min(5).max(10080).optional(),
  channels: z.array(z.enum(['app', 'telegram', 'email'])).min(1).optional(),
  enabled: z.boolean().optional(),
});
const RULE_COLS = Object.keys(ruleBody.shape) as (keyof z.infer<typeof ruleBody>)[];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsBody = z.object({
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).optional(),
  atRisk: z.object({ inactivityDays: z.number().int().min(1), failureRatePct: z.number().min(0).max(100), minExecutions: z.number().int().min(1) }).optional(),
  sync: z.object({ maxInitialExecutions: z.number().int().min(100).max(1000000), errorDetailsPerSync: z.number().int().min(0).max(1000) }).optional(),
  reports: z.object({ autoSendDay: z.number().int().min(1).max(28) }).optional(),
  notifyAdminOnClientAction: z.boolean().optional(),
});

export default async function alertRoutes(app: FastifyInstance) {
  app.get('/api/admin/alerts', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'active']).default('active'), client_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return q(`SELECT a.*, c.name client_name, w.name workflow_name, i.name instance_name FROM alerts a
              LEFT JOIN clients c ON c.id=a.client_id LEFT JOIN workflows w ON w.id=a.workflow_id LEFT JOIN instances i ON i.id=a.instance_id
              WHERE (CASE WHEN $1='active' THEN a.status <> 'resolved' ELSE a.status=$1 END) AND ($2::uuid IS NULL OR a.client_id=$2)
              ORDER BY a.last_seen_at DESC LIMIT $3`, [f.status, f.client_id ?? null, f.limit]);
  });

  app.post('/api/admin/alerts/:id/:action', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(numIdParam, { id: (req.params as any).id });
    const action = parse(z.enum(['acknowledge', 'resolve', 'reopen']), (req.params as any).action);
    const status = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'open';
    const r = await one<any>(`UPDATE alerts SET status=$2, resolved_at = CASE WHEN $2='resolved' THEN now() ELSE NULL END WHERE id=$1 RETURNING id, client_id`, [id, status]);
    if (!r) throw notFound('Alerte');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: `alert.${action}`, targetType: 'alert', targetId: id, clientId: r.client_id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/alert-rules', async (req) => {
    requireAdmin(req);
    return q(`SELECT r.*, c.name client_name, w.name workflow_name FROM alert_rules r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN workflows w ON w.id=r.workflow_id ORDER BY r.kind, c.name NULLS FIRST`);
  });

  app.post('/api/admin/alert-rules', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(ruleBody, req.body);
    const keys = RULE_COLS.filter((k) => b[k] !== undefined);
    const r = await one<any>(`INSERT INTO alert_rules(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map((k) => b[k]));
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'alert_rule.created', targetType: 'alert_rule', targetId: r.id, clientId: r.client_id, ip: req.ip, detail: b });
    reply.code(201);
    return r;
  });

  app.patch('/api/admin/alert-rules/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(ruleBody.partial(), req.body);
    const keys = RULE_COLS.filter((k) => b[k] !== undefined);
    if (!keys.length) return one('SELECT * FROM alert_rules WHERE id=$1', [id]);
    const r = await one<any>(`UPDATE alert_rules SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => b[k])]);
    if (!r) throw notFound('Règle');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'alert_rule.updated', targetType: 'alert_rule', targetId: id, ip: req.ip, detail: b });
    return r;
  });

  app.delete('/api/admin/alert-rules/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (!(await one('DELETE FROM alert_rules WHERE id=$1 RETURNING id', [id]))) throw notFound('Règle');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'alert_rule.deleted', targetType: 'alert_rule', targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/settings', async (req) => {
    requireAdmin(req);
    return {
      ...(await getSettings()),
      channels: { telegram: !!(config.telegram.botToken && config.telegram.adminChatId), email: !!config.smtp.host, adminEmail: config.adminEmail || null },
      timezone: config.timezone,
    };
  });

  app.patch('/api/admin/settings', async (req) => {
    const a = requireAdmin(req);
    const b = parse(settingsBody, req.body);
    for (const [k, v] of Object.entries(b)) if (v !== undefined) await saveSetting(k as any, v as any);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'settings.updated', ip: req.ip, detail: b });
    return getSettings();
  });

  app.post('/api/admin/settings/test-channel', async (req) => {
    requireAdmin(req);
    const b = parse(z.object({ channel: z.enum(['telegram', 'email']) }), req.body);
    try {
      if (b.channel === 'telegram') await sendTelegramNow(config.telegram.adminChatId, `✅ Test ${config.brand.productName} : le canal Telegram fonctionne.`);
      else await sendEmailNow(config.adminEmail || req.actor!.label, `Test ${config.brand.productName}`, 'Le canal e-mail fonctionne.');
      return { ok: true, message: 'Message de test envoyé.' };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  });
}
