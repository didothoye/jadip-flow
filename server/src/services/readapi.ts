import { one, q } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { notFound } from '../lib/errors.js';
import { clientsSummary, fleetOverview, listExecutions, recentErrors, workflowsWithStats } from './metrics.js';
import { costBreakdown } from './llm/costs.js';

/**
 * Lecture partagée par l'API REST v1 et le serveur MCP.
 * Un jeton client ne voit que son client (et seulement ses workflows visibles).
 */
const scope = (a: Actor, requested?: string | null) => {
  if (a.role === 'client') {
    if (requested && requested !== a.clientId) throw notFound('Client');
    return a.clientId!;
  }
  return requested ?? null;
};

const wfPublic = (w: any) => ({
  id: w.id, name: w.name, display_name: w.display_name, description: w.description, active: w.active, tags: w.tags,
  client_id: w.client_id, client_name: w.client_name, instance: w.instance_name, n8n_id: w.n8n_id, is_locked: w.is_locked,
  paused_until: w.paused_until, last_execution_at: w.last_execution_at, last_status: w.last_status,
  executions_30d: w.exec_30d, failures_30d: w.fail_30d, success_rate_30d: w.success_rate_30d,
  minutes_saved_per_execution: Number(w.minutes_saved_per_execution), minutes_saved_month: w.minutes_saved_month,
  unhandled_errors_7d: w.unhandled_errors_7d, deleted_at: w.deleted_at,
});

export async function apiClients(a: Actor) {
  const rows = await clientsSummary(a.role === 'client' ? a.clientId! : undefined);
  return rows.map((c) => ({
    id: c.id, code: c.code, name: c.name, is_internal: c.is_internal, workflows: c.workflows, workflows_active: c.workflows_active,
    executions_30d: c.exec_30d, failures_30d: c.fail_30d, success_rate_30d: c.success_rate_30d, last_execution_at: c.last_execution_at,
    minutes_saved_month: c.minutes_saved_month, llm_cost_month_usd: c.llm_month_usd, alerts_open: c.alerts_open, at_risk: c.at_risk, risks: c.risks,
  }));
}

export async function apiWorkflows(a: Actor, f: { clientId?: string | null; search?: string }) {
  const rows = await workflowsWithStats({ clientId: scope(a, f.clientId), visibleOnly: a.role === 'client', search: f.search });
  return rows.map(wfPublic);
}

export async function apiWorkflow(a: Actor, id: string) {
  const [w] = await workflowsWithStats({ workflowId: id, clientId: a.role === 'client' ? a.clientId : undefined, visibleOnly: a.role === 'client', includeDeleted: a.role === 'admin' });
  if (!w) throw notFound('Workflow');
  const errors = await recentErrors({ workflowId: id, limit: 10 });
  return { ...wfPublic(w), recent_errors: errors.map(errPublic) };
}

const errPublic = (e: any) => ({
  execution_id: e.id, n8n_execution_id: e.n8n_execution_id, workflow_id: e.workflow_id, workflow_name: e.workflow_name, client_name: e.client_name,
  started_at: e.started_at, error_node: e.error_node, error_category: e.error_category, error_message: e.error_message, handled: !!e.handled_at,
});

export async function apiErrors(a: Actor, f: { clientId?: string | null; workflowId?: string; category?: string; unhandled?: boolean; limit?: number }) {
  const rows = await recentErrors({ clientId: scope(a, f.clientId), workflowId: f.workflowId, category: f.category, unhandledOnly: f.unhandled, limit: f.limit ?? 50, visibleOnly: a.role === 'client' });
  return rows.map(errPublic);
}

export async function apiExecutions(a: Actor, f: { clientId?: string | null; workflowId?: string; status?: string; from?: string; to?: string; cursor?: string; limit?: number }) {
  return listExecutions({ ...f, clientId: scope(a, f.clientId), visibleOnly: a.role === 'client' });
}

export async function apiCosts(a: Actor, f: { clientId?: string | null; from: string; to: string }) {
  const c = scope(a, f.clientId);
  if (a.role === 'client') {
    const cl = await one<any>('SELECT show_costs FROM clients WHERE id=$1', [c]);
    if (!cl?.show_costs) throw notFound('Coûts');
  }
  return costBreakdown({ clientId: c, from: f.from, to: f.to });
}

export async function apiOverview(a: Actor) {
  if (a.role === 'client') return { clients: await apiClients(a) };
  const [overview, alerts] = await Promise.all([
    fleetOverview(),
    q(`SELECT a.id, a.kind, a.severity, a.title, a.message, a.occurrences, a.last_seen_at, c.name client_name FROM alerts a LEFT JOIN clients c ON c.id=a.client_id WHERE a.status='open' ORDER BY a.last_seen_at DESC LIMIT 20`),
  ]);
  return { overview, open_alerts: alerts, clients_at_risk: (await apiClients(a)).filter((c) => c.at_risk) };
}
