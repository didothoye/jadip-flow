import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { one, q } from '../../db.js';
import { audit } from '../../audit.js';
import { requireAdmin } from '../../auth.js';
import { encrypt, decrypt, maskSecret } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { dataPath } from '../../lib/files.js';
import { idParam, parse, z } from '../../lib/validate.js';
import { currentPeriod } from '../../lib/time.js';
import { costBreakdown, fetchAccount, reattribute, computeEstimates } from '../../services/llm/costs.js';
import { emailReport, generateReport, profitability, reportFileExists } from '../../services/reports.js';

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'format AAAA-MM');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function sendReportFile(reply: FastifyReply, r: any, format: 'pdf' | 'xlsx', clientCode: string) {
  const p = format === 'pdf' ? r.pdf_path : r.xlsx_path;
  if (!reportFileExists(p)) throw notFound('Fichier du rapport');
  reply.type(format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  reply.header('content-disposition', `attachment; filename="Rapport-${clientCode}-${r.period}.${format}"`);
  reply.header('cache-control', 'private, no-store');
  return reply.send(createReadStream(dataPath(p)));
}

export default async function costRoutes(app: FastifyInstance) {
  // --- comptes fournisseurs
  app.get('/api/admin/llm/accounts', async (req) => {
    requireAdmin(req);
    const rows = await q<any>(`SELECT a.*, (SELECT count(*)::int FROM llm_attribution_rules r WHERE r.account_id=a.id) rules FROM llm_accounts a ORDER BY provider, name`);
    return rows.map(({ api_key_enc, ...a }) => ({ ...a, api_key_hint: api_key_enc ? maskSecret(decrypt(api_key_enc)) : null }));
  });

  app.post('/api/admin/llm/accounts', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ provider: z.enum(['openai', 'anthropic', 'openrouter', 'manual']), name: z.string().min(1).max(100), api_key: z.string().min(10).optional() }), req.body);
    if (b.provider !== 'manual' && !b.api_key) throw badRequest('Clé API requise pour ce fournisseur.');
    const r = await one<any>(`INSERT INTO llm_accounts(provider, name, api_key_enc) VALUES ($1,$2,$3) RETURNING id, provider, name, enabled`, [b.provider, b.name, b.api_key ? encrypt(b.api_key) : null]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_account.created', targetType: 'llm_account', targetId: r.id, ip: req.ip, detail: { provider: b.provider, name: b.name } });
    reply.code(201);
    return r;
  });

  app.patch('/api/admin/llm/accounts/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().min(1).max(100).optional(), api_key: z.string().min(10).optional(), enabled: z.boolean().optional() }), req.body);
    const r = await one(`UPDATE llm_accounts SET name=COALESCE($2,name), api_key_enc=COALESCE($3,api_key_enc), enabled=COALESCE($4,enabled) WHERE id=$1 RETURNING id`,
      [id, b.name ?? null, b.api_key ? encrypt(b.api_key) : null, b.enabled ?? null]);
    if (!r) throw notFound('Compte');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_account.updated', targetType: 'llm_account', targetId: id, ip: req.ip, detail: { name: b.name, enabled: b.enabled, api_key_changed: !!b.api_key } });
    return { ok: true };
  });

  app.delete('/api/admin/llm/accounts/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (!(await one('DELETE FROM llm_accounts WHERE id=$1 RETURNING id', [id]))) throw notFound('Compte');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_account.deleted', targetType: 'llm_account', targetId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/llm/accounts/:id/fetch', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ days: z.number().int().min(1).max(90).default(7) }), req.body ?? {});
    try {
      return { ok: true, ...(await fetchAccount(id, b.days)) };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  });

  // --- règles d'attribution
  app.get('/api/admin/llm/rules', async (req) => {
    requireAdmin(req);
    return q(`SELECT r.*, a.name account_name, a.provider, c.name client_name, w.name workflow_name FROM llm_attribution_rules r
              JOIN llm_accounts a ON a.id=r.account_id JOIN clients c ON c.id=r.client_id LEFT JOIN workflows w ON w.id=r.workflow_id ORDER BY a.name, r.dimension`);
  });

  app.get('/api/admin/llm/unattributed', async (req) => {
    requireAdmin(req);
    return q(`SELECT account_id, provider, project, workspace, api_key_ref, model, sum(cost_usd)::float cost_usd FROM llm_usage
              WHERE client_id IS NULL AND source='api' AND day >= current_date - 90 GROUP BY 1,2,3,4,5,6 ORDER BY 7 DESC LIMIT 200`);
  });

  app.post('/api/admin/llm/rules', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ account_id: z.string().uuid(), dimension: z.enum(['project', 'api_key', 'workspace', 'model']), match_value: z.string().min(1).max(200), client_id: z.string().uuid(), workflow_id: z.string().uuid().nullable().optional() }), req.body);
    const r = await one<any>(`INSERT INTO llm_attribution_rules(account_id, dimension, match_value, client_id, workflow_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (account_id, dimension, match_value) DO UPDATE SET client_id=EXCLUDED.client_id, workflow_id=EXCLUDED.workflow_id RETURNING *`,
      [b.account_id, b.dimension, b.match_value, b.client_id, b.workflow_id ?? null]);
    const n = await reattribute(b.account_id);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_rule.saved', targetType: 'llm_rule', targetId: r.id, clientId: b.client_id, ip: req.ip, detail: b });
    reply.code(201);
    return { ...r, reattributed: n };
  });

  app.delete('/api/admin/llm/rules/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const r = await one<any>('DELETE FROM llm_attribution_rules WHERE id=$1 RETURNING account_id', [id]);
    if (!r) throw notFound('Règle');
    await reattribute(r.account_id);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_rule.deleted', targetType: 'llm_rule', targetId: id, ip: req.ip });
    return { ok: true };
  });

  // --- saisie manuelle
  app.post('/api/admin/llm/manual', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({
      day: isoDay, provider: z.string().min(1).max(50), model: z.string().min(1).max(100), cost_usd: z.number().min(0).max(1000000),
      client_id: z.string().uuid().nullable().optional(), workflow_id: z.string().uuid().nullable().optional(), note: z.string().max(500).optional(),
      input_tokens: z.number().int().min(0).optional(), output_tokens: z.number().int().min(0).optional(),
    }), req.body);
    const r = await one<any>(`INSERT INTO llm_usage(source, day, provider, model, cost_usd, client_id, workflow_id, note, input_tokens, output_tokens)
      VALUES ('manual',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.day, b.provider, b.model, b.cost_usd, b.client_id ?? null, b.workflow_id ?? null, b.note ?? null, b.input_tokens ?? 0, b.output_tokens ?? 0]);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_usage.manual_added', targetType: 'llm_usage', targetId: r.id, clientId: b.client_id ?? null, ip: req.ip, detail: b });
    reply.code(201);
    return r;
  });

  app.delete('/api/admin/llm/manual/:id', async (req) => {
    const a = requireAdmin(req);
    const id = Number((req.params as any).id);
    const r = await one<any>(`DELETE FROM llm_usage WHERE id=$1 AND source='manual' RETURNING client_id`, [id]);
    if (!r) throw notFound('Saisie');
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'llm_usage.manual_deleted', targetType: 'llm_usage', targetId: id, clientId: r.client_id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/llm/entries', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ source: z.enum(['api', 'manual', 'estimate']).optional(), client_id: z.string().uuid().optional() }), req.query);
    return q(`SELECT u.*, c.name client_name, COALESCE(w.display_name, w.name) workflow_name FROM llm_usage u LEFT JOIN clients c ON c.id=u.client_id LEFT JOIN workflows w ON w.id=u.workflow_id
              WHERE ($1::text IS NULL OR u.source=$1) AND ($2::uuid IS NULL OR u.client_id=$2) ORDER BY u.day DESC, u.id DESC LIMIT 300`, [f.source ?? null, f.client_id ?? null]);
  });

  app.get('/api/admin/costs', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ from: isoDay.optional(), to: isoDay.optional(), client_id: z.string().uuid().optional() }), req.query);
    const from = f.from ?? `${currentPeriod()}-01`;
    const to = f.to ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await computeEstimates(40);
    return { from, to, ...(await costBreakdown({ clientId: f.client_id, from, to })) };
  });

  // --- rentabilité
  app.get('/api/admin/profitability', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ period: period.optional() }), req.query);
    const p = f.period ?? currentPeriod();
    return { period: p, rows: await profitability(p) };
  });

  // --- rapports
  app.get('/api/admin/reports', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional() }), req.query);
    return q(`SELECT r.id, r.client_id, c.name client_name, r.period, r.emailed_at, r.created_at, r.summary->'totals' totals FROM reports r JOIN clients c ON c.id=r.client_id
              WHERE ($1::uuid IS NULL OR r.client_id=$1) ORDER BY r.period DESC, c.name`, [f.client_id ?? null]);
  });

  app.post('/api/admin/reports', async (req, reply) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ client_id: z.string().uuid(), period, send: z.boolean().default(false) }), req.body);
    const r = await generateReport(b.client_id, b.period);
    let sent = 0;
    if (b.send) sent = await emailReport(r.id);
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'report.generated', targetType: 'report', targetId: r.id, clientId: b.client_id, ip: req.ip, detail: { period: b.period, sent } });
    reply.code(201);
    return { id: r.id, period: r.period, summary: r.summary, sent };
  });

  app.post('/api/admin/reports/:id/send', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const n = await emailReport(id).catch((e) => { throw badRequest(e.message); });
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'report.sent', targetType: 'report', targetId: id, ip: req.ip, detail: { recipients: n } });
    return { sent: n };
  });

  app.get('/api/admin/reports/:id/:format', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(idParam, { id: (req.params as any).id });
    const format = parse(z.enum(['pdf', 'xlsx']), (req.params as any).format);
    const r = await one<any>('SELECT r.*, c.code FROM reports r JOIN clients c ON c.id=r.client_id WHERE r.id=$1', [id]);
    if (!r) throw notFound('Rapport');
    return sendReportFile(reply, r, format, r.code);
  });
}
