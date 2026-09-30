import type { FastifyInstance } from 'fastify';
import { one, q } from '../../db.js';
import { audit } from '../../audit.js';
import { requireAdmin } from '../../auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idParam, numIdParam, parse, z } from '../../lib/validate.js';
import { markHandled, retryExecution, setWorkflowActive } from '../../services/actions.js';
import { dailySeries, errorCategoryCounts, fleetOverview, clientsSummary, listExecutions, recentErrors, workflowsWithStats } from '../../services/metrics.js';

const execQuery = z.object({
  client_id: z.string().uuid().optional(), workflow_id: z.string().uuid().optional(), instance_id: z.string().uuid().optional(),
  status: z.string().max(20).optional(), category: z.enum(['auth', 'rate_limit', 'network', 'data', 'logic']).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
});

export default async function workflowRoutes(app: FastifyInstance) {
  app.get('/api/admin/overview', async (req) => {
    requireAdmin(req);
    const [overview, series, errors, categories, clients, instances] = await Promise.all([
      fleetOverview(), dailySeries({ days: 14 }), recentErrors({ limit: 10, unhandledOnly: true }), errorCategoryCounts(7), clientsSummary(),
      q(`SELECT id, name, health_status, health_message, last_sync_at, last_sync_status FROM instances ORDER BY name`),
    ]);
    return { overview, series, errors, categories, clients, instances };
  });

  app.get('/api/admin/workflows', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({
      client_id: z.string().uuid().optional(), instance_id: z.string().uuid().optional(), search: z.string().max(100).optional(),
      unassigned: z.coerce.boolean().optional(), include_deleted: z.coerce.boolean().optional(),
    }), req.query);
    return workflowsWithStats({ clientId: f.client_id, instanceId: f.instance_id, search: f.search, unassigned: f.unassigned, includeDeleted: f.include_deleted });
  });

  app.get('/api/admin/workflows/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const [wf] = await workflowsWithStats({ workflowId: id, includeDeleted: true });
    if (!wf) throw notFound('Workflow');
    const [series, errors, categories, events, actions] = await Promise.all([
      dailySeries({ workflowId: id, days: 30 }),
      recentErrors({ workflowId: id, limit: 20 }),
      (q(`SELECT COALESCE(error_category,'logic') category, count(*)::int n FROM executions WHERE workflow_id=$1 AND status IN ('error','crashed') AND started_at > now() - interval '30 days' GROUP BY 1`, [id])),
      q(`SELECT * FROM workflow_events WHERE workflow_id=$1 ORDER BY created_at DESC LIMIT 50`, [id]),
      q(`SELECT l.*, u.email actor_email FROM action_log l LEFT JOIN users u ON u.id=l.actor_user_id WHERE l.workflow_id=$1 ORDER BY l.created_at DESC LIMIT 50`, [id]),
    ]);
    return { workflow: wf, series, errors, categories, events, actions, n8n_url: `${wf.instance_url.replace(/\/$/, '')}/workflow/${wf.n8n_id}` };
  });

  app.patch('/api/admin/workflows/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      display_name: z.string().max(200).nullable().optional(),
      description: z.string().max(5000).nullable().optional(),
      minutes_saved_per_execution: z.number().min(0).max(100000).optional(),
      cost_per_execution_usd: z.number().min(0).max(1000).optional(),
      is_locked: z.boolean().optional(), client_visible: z.boolean().optional(),
      client_can_toggle: z.boolean().optional(), client_can_retry: z.boolean().optional(),
      client_id: z.string().uuid().nullable().optional(),
      assignment: z.enum(['manual', 'tag']).optional(), // « tag » : revenir au rattachement automatique
    }), req.body);
    const cur = await one<any>('SELECT id, client_id FROM workflows WHERE id=$1', [id]);
    if (!cur) throw notFound('Workflow');
    const cols = ['display_name', 'description', 'minutes_saved_per_execution', 'cost_per_execution_usd', 'is_locked', 'client_visible', 'client_can_toggle', 'client_can_retry'] as const;
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const k of cols) if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k}=$${vals.length}`); }
    if (b.client_id !== undefined) {
      vals.push(b.client_id);
      sets.push(`client_id=$${vals.length}`, `client_assignment='manual'`);
    }
    if (b.assignment === 'tag' && b.client_id === undefined) sets.push(`client_assignment='none'`);
    if (!sets.length) throw badRequest('Aucune modification');
    await q(`UPDATE workflows SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
    if (b.client_id !== undefined) {
      await q('UPDATE executions SET client_id=$2 WHERE workflow_id=$1', [id, b.client_id]);
      await q(`INSERT INTO workflow_events(workflow_id, kind, detail) VALUES ($1,'assigned',$2)`, [id, { clientId: b.client_id, via: 'manual', by: a.label }]);
    }
    await audit({ actorUserId: a.userId, actorLabel: a.label, source: a.source, action: 'workflow.updated', targetType: 'workflow', targetId: id, clientId: b.client_id ?? cur.client_id, ip: req.ip, detail: b });
    const [wf] = await workflowsWithStats({ workflowId: id, includeDeleted: true });
    return wf;
  });

  app.post('/api/admin/workflows/:id/activate', async (req) => setWorkflowActive(requireAdmin(req), parse(idParam, req.params).id, true));
  app.post('/api/admin/workflows/:id/deactivate', async (req) => {
    const b = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    return setWorkflowActive(requireAdmin(req), parse(idParam, req.params).id, false, { reason: b.reason });
  });

  app.get('/api/admin/executions', async (req) => {
    requireAdmin(req);
    const f = parse(execQuery, req.query);
    return listExecutions({ clientId: f.client_id, workflowId: f.workflow_id, instanceId: f.instance_id, status: f.status, category: f.category, from: f.from, to: f.to, cursor: f.cursor, limit: f.limit });
  });

  app.get('/api/admin/errors', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({
      client_id: z.string().uuid().optional(), workflow_id: z.string().uuid().optional(),
      category: z.enum(['auth', 'rate_limit', 'network', 'data', 'logic']).optional(),
      unhandled: z.coerce.boolean().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
    }), req.query);
    const [items, categories] = await Promise.all([
      recentErrors({ clientId: f.client_id, workflowId: f.workflow_id, category: f.category, unhandledOnly: f.unhandled, before: f.before, limit: f.limit ?? 100 }),
      errorCategoryCounts(7, f.client_id),
    ]);
    return { items, categories };
  });

  app.post('/api/admin/executions/handled', async (req) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(1000), handled: z.boolean().default(true) }), req.body);
    return { updated: await markHandled(a, b.ids, b.handled) };
  });

  app.post('/api/admin/executions/:id/retry', async (req) => retryExecution(requireAdmin(req), parse(numIdParam, req.params).id));

  app.get('/api/admin/actions', async (req) => {
    requireAdmin(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return q(`SELECT l.*, u.email actor_email, w.name workflow_name, c.name client_name FROM action_log l
              LEFT JOIN users u ON u.id=l.actor_user_id LEFT JOIN workflows w ON w.id=l.workflow_id LEFT JOIN clients c ON c.id=l.client_id
              WHERE ($1::uuid IS NULL OR l.client_id=$1) ORDER BY l.created_at DESC LIMIT $2`, [f.client_id ?? null, f.limit]);
  });
}
