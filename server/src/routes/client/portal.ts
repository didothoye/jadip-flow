import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { one, q } from '../../db.js';
import { requireClient } from '../../auth.js';
import { forbidden, notFound, badRequest } from '../../lib/errors.js';
import { dataPath } from '../../lib/files.js';
import { idParam, numIdParam, parse, z } from '../../lib/validate.js';
import { currentPeriod } from '../../lib/time.js';
import { clientExplanations, type ErrorCategory } from '../../services/classify.js';
import { dailySeries, listExecutions, workflowsWithStats } from '../../services/metrics.js';
import { retryExecution, setWorkflowActive } from '../../services/actions.js';
import { addMessage, createTicket, readTicketForm, ticketDetail } from '../../services/tickets.js';
import { sendReportFile } from '../admin/costs.js';

/**
 * Espace client. Règle d'or : l'identifiant du client vient TOUJOURS de la session,
 * jamais de la requête ; toute ressource d'un autre client répond « introuvable ».
 */

const STATUS_LABEL: Record<string, string> = { success: 'Réussie', error: 'Incident', crashed: 'Incident', running: 'En cours', waiting: 'En attente', canceled: 'Annulée', new: 'En attente' };

/** Vue « client » d'un workflow : aucun détail technique (identifiants n8n, étiquettes, instance, nœuds). */
function cardOf(w: any, perms: { can_toggle: boolean; can_retry: boolean }) {
  return {
    id: w.id, name: w.display_name || w.name, description: w.description, active: w.active, paused_until: w.paused_until,
    last_execution_at: w.last_execution_at, last_status: w.last_status ? STATUS_LABEL[w.last_status] ?? w.last_status : null,
    success_rate_30d: w.success_rate_30d, executions_30d: w.exec_30d, failures_30d: w.fail_30d,
    minutes_saved_month: w.minutes_saved_month, locked: w.is_locked,
    can_toggle: perms.can_toggle && w.client_can_toggle && !(w.is_locked && w.active),
    can_retry: perms.can_retry && w.client_can_retry,
  };
}

function execOf(e: any) {
  const cat = e.error_category as ErrorCategory | null;
  return {
    id: e.id, status: e.status, status_label: STATUS_LABEL[e.status] ?? e.status, started_at: e.started_at, duration_ms: e.duration_ms,
    explanation: ['error', 'crashed'].includes(e.status) ? clientExplanations[cat ?? 'logic'] : null,
    retried: !!e.retry_of, handled: !!e.handled_at,
  };
}

async function clientRow(clientId: string) {
  const c = await one<any>(`SELECT id, name, logo_path, can_toggle, can_retry, show_costs, show_reports, monthly_budget_usd FROM clients WHERE id=$1 AND archived_at IS NULL`, [clientId]);
  if (!c) throw forbidden('Espace client indisponible.');
  return c;
}

async function ownWorkflow(clientId: string, workflowId: string) {
  const [w] = await workflowsWithStats({ workflowId, clientId, visibleOnly: true });
  if (!w) throw notFound('Automatisation');
  return w;
}

export default async function portalRoutes(app: FastifyInstance) {
  app.get('/api/portal/home', async (req) => {
    const a = requireClient(req);
    const c = await clientRow(a.clientId);
    const wfs = await workflowsWithStats({ clientId: a.clientId, visibleOnly: true });
    const cards = wfs.map((w) => cardOf(w, c));
    const ok = wfs.reduce((s, w) => s + w.ok_30d, 0);
    const fail = wfs.reduce((s, w) => s + w.fail_30d, 0);
    return {
      client: { id: c.id, name: c.name, has_logo: !!c.logo_path, show_costs: c.show_costs, show_reports: c.show_reports },
      summary: {
        active: cards.filter((x) => x.active).length, total: cards.length,
        minutes_saved_month: cards.reduce((s, x) => s + x.minutes_saved_month, 0),
        success_rate_30d: ok + fail ? ok / (ok + fail) : null, executions_30d: ok + fail,
        incidents_7d: (await one<any>(`SELECT count(*)::int n FROM executions e JOIN workflows w ON w.id=e.workflow_id WHERE e.client_id=$1 AND w.client_visible AND e.status IN ('error','crashed') AND e.started_at > now() - interval '7 days'`, [a.clientId]))!.n,
      },
      workflows: cards,
    };
  });

  app.get('/api/portal/workflows/:id', async (req) => {
    const a = requireClient(req);
    const { id } = parse(idParam, req.params);
    const c = await clientRow(a.clientId);
    const w = await ownWorkflow(a.clientId, id);
    const [series, execs] = await Promise.all([
      dailySeries({ workflowId: id, clientId: a.clientId, days: 30 }),
      listExecutions({ workflowId: id, clientId: a.clientId, limit: 20, visibleOnly: true }),
    ]);
    return { workflow: cardOf(w, c), series, executions: execs.items.map(execOf), next_cursor: execs.nextCursor };
  });

  app.get('/api/portal/workflows/:id/executions', async (req) => {
    const a = requireClient(req);
    const { id } = parse(idParam, req.params);
    const f = parse(z.object({ cursor: z.string().max(200).optional(), status: z.enum(['success', 'failed']).optional() }), req.query);
    await ownWorkflow(a.clientId, id);
    const r = await listExecutions({ workflowId: id, clientId: a.clientId, cursor: f.cursor, status: f.status, limit: 50, visibleOnly: true });
    return { items: r.items.map(execOf), next_cursor: r.nextCursor };
  });

  app.post('/api/portal/workflows/:id/:action', async (req) => {
    const a = requireClient(req);
    const { id } = parse(idParam, { id: (req.params as any).id });
    const action = parse(z.enum(['activate', 'deactivate', 'pause']), (req.params as any).action);
    await ownWorkflow(a.clientId, id);
    if (action === 'pause') {
      const b = parse(z.object({ hours: z.number().int().min(1).max(24 * 30) }), req.body);
      return setWorkflowActive(a, id, false, { pauseUntil: new Date(Date.now() + b.hours * 3600000) });
    }
    return setWorkflowActive(a, id, action === 'activate');
  });

  app.post('/api/portal/executions/:id/retry', async (req) => {
    const a = requireClient(req);
    const { id } = parse(numIdParam, req.params);
    const e = await one<any>(`SELECT e.id FROM executions e JOIN workflows w ON w.id=e.workflow_id WHERE e.id=$1 AND e.client_id=$2 AND w.client_visible`, [id, a.clientId]);
    if (!e) throw notFound('Exécution');
    return retryExecution(a, id);
  });

  app.get('/api/portal/costs', async (req) => {
    const a = requireClient(req);
    const c = await clientRow(a.clientId);
    if (!c.show_costs) throw forbidden('Les coûts ne sont pas affichés pour votre compte.');
    const f = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    const month = await q<any>(`SELECT COALESCE(w.display_name, w.name, 'Autres usages') name, sum(u.cost_usd)::float cost_usd FROM llm_usage u
      LEFT JOIN workflows w ON w.id=u.workflow_id WHERE u.client_id=$1 AND u.day >= date_trunc('month', now())::date AND (w.id IS NULL OR w.client_visible) GROUP BY 1 ORDER BY 2 DESC`, [a.clientId]);
    const history = await q<any>(`SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS period, sum(cost_usd)::float cost_usd FROM llm_usage
      WHERE client_id=$1 AND day >= (date_trunc('month', now()) - ($2::int - 1) * interval '1 month')::date GROUP BY 1 ORDER BY 1`, [a.clientId, f.months]);
    const total = month.reduce((s, r) => s + r.cost_usd, 0);
    return { period: currentPeriod(), budget_usd: c.monthly_budget_usd, month_total_usd: total, by_workflow: month, history };
  });

  app.get('/api/portal/reports', async (req) => {
    const a = requireClient(req);
    const c = await clientRow(a.clientId);
    if (!c.show_reports) throw forbidden('Les rapports ne sont pas disponibles pour votre compte.');
    return q(`SELECT id, period, created_at, summary->'totals' totals FROM reports WHERE client_id=$1 ORDER BY period DESC`, [a.clientId]);
  });

  app.get('/api/portal/reports/:id/:format', async (req, reply) => {
    const a = requireClient(req);
    const c = await clientRow(a.clientId);
    if (!c.show_reports) throw forbidden();
    const { id } = parse(idParam, { id: (req.params as any).id });
    const format = parse(z.enum(['pdf', 'xlsx']), (req.params as any).format);
    const r = await one<any>('SELECT r.*, cl.code FROM reports r JOIN clients cl ON cl.id=r.client_id WHERE r.id=$1 AND r.client_id=$2', [id, a.clientId]);
    if (!r) throw notFound('Rapport');
    return sendReportFile(reply, r, format, r.code);
  });

  app.get('/api/portal/activity', async (req) => {
    const a = requireClient(req);
    return q(`SELECT l.id, l.action, l.result, l.created_at, u.name actor_name, COALESCE(w.display_name, w.name) workflow_name FROM action_log l
      LEFT JOIN users u ON u.id=l.actor_user_id LEFT JOIN workflows w ON w.id=l.workflow_id
      WHERE l.client_id=$1 AND (w.id IS NULL OR w.client_visible) ORDER BY l.created_at DESC LIMIT 100`, [a.clientId]);
  });

  // --- demandes
  app.get('/api/portal/tickets', async (req) => {
    const a = requireClient(req);
    return q(`SELECT t.id, t.kind, t.subject, t.status, t.created_at, t.updated_at, COALESCE(w.display_name, w.name) workflow_name,
      (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id=t.id) messages
      FROM tickets t LEFT JOIN workflows w ON w.id=t.workflow_id WHERE t.client_id=$1 ORDER BY t.updated_at DESC`, [a.clientId]);
  });

  app.post('/api/portal/tickets', async (req, reply) => {
    const a = requireClient(req);
    const form = await readTicketForm(req, `tickets/${a.clientId}`);
    const t = await createTicket(a, { kind: form.fields.kind, subject: form.fields.subject, body: form.fields.body, workflowId: form.fields.workflow_id || null }, form.files);
    reply.code(201);
    return { id: t.id };
  });

  app.get('/api/portal/tickets/:id', async (req) => {
    const a = requireClient(req);
    const { id } = parse(numIdParam, req.params);
    const t = await ticketDetail(id);
    if (!t || t.client_id !== a.clientId) throw notFound('Demande');
    return t;
  });

  app.post('/api/portal/tickets/:id/messages', async (req) => {
    const a = requireClient(req);
    const { id } = parse(numIdParam, req.params);
    const t = await one<any>('SELECT * FROM tickets WHERE id=$1 AND client_id=$2', [id, a.clientId]);
    if (!t) throw notFound('Demande');
    if (t.status === 'closed') throw badRequest('Cette demande est fermée.');
    const form = await readTicketForm(req, `tickets/${a.clientId}`);
    return addMessage(a, t, form.fields.body ?? '', form.files);
  });

  app.get('/api/portal/attachments/:id', async (req, reply) => {
    const a = requireClient(req);
    const { id } = parse(idParam, req.params);
    const f = await one<any>(`SELECT f.* FROM ticket_attachments f JOIN tickets t ON t.id=f.ticket_id WHERE f.id=$1 AND t.client_id=$2`, [id, a.clientId]);
    if (!f) throw notFound('Pièce jointe');
    return sendAttachment(reply, f);
  });
}

export function sendAttachment(reply: FastifyReply, f: any) {
  const p = dataPath(f.storage_path);
  if (!existsSync(p)) throw notFound('Pièce jointe');
  reply.type(f.mime);
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  return reply.send(createReadStream(p));
}
