import { one, q } from '../db.js';
import { audit } from '../audit.js';
import type { Actor } from '../lib/actor.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { clientFor } from './sync.js';
import { notifyAdmins } from './notify.js';
import { emitEvent } from './webhooks.js';
import { getSettings } from './settings.js';

async function logAction(actor: Actor, a: { clientId: string | null; workflowId: string | null; action: string; result: 'ok' | 'error' | 'refused'; message?: string; detail?: Record<string, unknown> }) {
  await q(`INSERT INTO action_log(actor_user_id, actor_role, client_id, workflow_id, action, result, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actor.userId || null, actor.role, a.clientId, a.workflowId, a.action, a.result, a.message ?? null]);
  await audit({ actorUserId: actor.userId || null, actorLabel: actor.label, source: actor.source, action: `workflow.${a.action}`,
    targetType: 'workflow', targetId: a.workflowId, clientId: a.clientId, ip: actor.ip, detail: { result: a.result, message: a.message, ...a.detail } });
}

async function loadWorkflowForActor(actor: Actor, workflowId: string) {
  const wf = await one<any>(`
    SELECT w.*, i.base_url, i.api_key_enc, c.name AS client_name, c.can_toggle, c.can_retry
    FROM workflows w JOIN instances i ON i.id=w.instance_id LEFT JOIN clients c ON c.id=w.client_id
    WHERE w.id=$1 AND w.deleted_at IS NULL`, [workflowId]);
  // cloisonnement : un client ne voit jamais l'existence des workflows d'un autre
  if (!wf || (actor.role === 'client' && (wf.client_id !== actor.clientId || !wf.client_visible))) throw notFound('Automatisation');
  return wf;
}

async function notifyClientAction(actor: Actor, wf: any, text: string) {
  if (actor.role !== 'client') return;
  const s = await getSettings();
  if (!s.notifyAdminOnClientAction) return;
  await notifyAdmins({ title: `Action client : ${wf.client_name ?? ''}`, body: `${actor.label} — ${text} « ${wf.name} »`, link: `/agence/workflows/${wf.id}`, clientId: wf.client_id });
}

export interface ToggleOptions { pauseUntil?: Date | null; reason?: string }

export async function setWorkflowActive(actor: Actor, workflowId: string, active: boolean, opts: ToggleOptions = {}) {
  const wf = await loadWorkflowForActor(actor, workflowId);
  const action = opts.pauseUntil ? 'pause' : active ? 'activate' : 'deactivate';
  const refuse = async (msg: string) => {
    await logAction(actor, { clientId: wf.client_id, workflowId, action, result: 'refused', message: msg });
    throw forbidden(msg);
  };
  if (!active && wf.is_locked) await refuse('Ce workflow est marqué critique : il ne peut pas être désactivé depuis le portail.');
  if (actor.role === 'client') {
    if (!wf.can_toggle || !wf.client_can_toggle) await refuse('Vous n’êtes pas autorisé à modifier l’état de cette automatisation.');
  }
  if (actor.scopes && !actor.scopes.includes('write')) await refuse('Jeton en lecture seule.');

  const n8n = clientFor(wf);
  try {
    if (active) await n8n.activate(wf.n8n_id);
    else await n8n.deactivate(wf.n8n_id);
  } catch (e: any) {
    await logAction(actor, { clientId: wf.client_id, workflowId, action, result: 'error', message: e.message });
    throw new HttpError(502, `n8n a refusé l’opération : ${e.message}`, 'n8n_error');
  }
  await q(`UPDATE workflows SET active=$2, paused_until=$3, updated_at=now() WHERE id=$1`, [workflowId, active, active ? null : opts.pauseUntil ?? null]);
  await q(`INSERT INTO workflow_events(workflow_id, kind, detail) VALUES ($1,$2,$3)`,
    [workflowId, active ? 'activated' : 'deactivated', { by: actor.label, role: actor.role, pauseUntil: opts.pauseUntil ?? null, reason: opts.reason ?? null }]);
  const message = opts.pauseUntil ? `Pause jusqu’au ${opts.pauseUntil.toISOString()}` : opts.reason;
  await logAction(actor, { clientId: wf.client_id, workflowId, action, result: 'ok', message });
  await emitEvent(active ? 'workflow.activated' : 'workflow.deactivated', { workflowId, name: wf.name, by: actor.label, role: actor.role }, wf.client_id);
  if (!active && actor.role === 'client') {
    await emitEvent('workflow.deactivated_by_client', { workflowId, name: wf.name, by: actor.label, pauseUntil: opts.pauseUntil ?? null }, wf.client_id);
  }
  await notifyClientAction(actor, wf, opts.pauseUntil ? 'a mis en pause' : active ? 'a activé' : 'a désactivé');
  return { id: workflowId, active, pausedUntil: active ? null : opts.pauseUntil ?? null };
}

export async function retryExecution(actor: Actor, executionId: number) {
  const ex = await one<any>('SELECT id, workflow_id, n8n_execution_id, status FROM executions WHERE id=$1', [executionId]);
  if (!ex) throw notFound('Exécution');
  const wf = await loadWorkflowForActor(actor, ex.workflow_id);
  const refuse = async (msg: string) => {
    await logAction(actor, { clientId: wf.client_id, workflowId: wf.id, action: 'retry', result: 'refused', message: msg });
    throw forbidden(msg);
  };
  if (!['error', 'crashed'].includes(ex.status)) await refuse('Seule une exécution en échec peut être relancée.');
  if (actor.role === 'client' && (!wf.can_retry || !wf.client_can_retry)) await refuse('La relance n’est pas autorisée pour cette automatisation.');
  if (actor.scopes && !actor.scopes.includes('write')) await refuse('Jeton en lecture seule.');
  let r;
  try {
    r = await clientFor(wf).retry(ex.n8n_execution_id);
  } catch (e: any) {
    await logAction(actor, { clientId: wf.client_id, workflowId: wf.id, action: 'retry', result: 'error', message: e.message });
    throw new HttpError(502, `n8n a refusé la relance : ${e.message}`, 'n8n_error');
  }
  if (!r.supported) {
    await logAction(actor, { clientId: wf.client_id, workflowId: wf.id, action: 'retry', result: 'error', message: 'Relance non prise en charge par cette version de n8n' });
    throw new HttpError(501, 'Cette version de n8n ne permet pas la relance via l’API. Relancez depuis n8n.', 'retry_unsupported');
  }
  await logAction(actor, { clientId: wf.client_id, workflowId: wf.id, action: 'retry', result: 'ok', message: `Exécution ${ex.n8n_execution_id} relancée`, detail: { newExecutionId: r.newExecutionId } });
  await notifyClientAction(actor, wf, 'a relancé une exécution de');
  return { retried: true, newExecutionId: r.newExecutionId ?? null };
}

export async function markHandled(actor: Actor, executionIds: number[], handled = true) {
  const rows = await q<{ id: number; workflow_id: string; client_id: string | null }>(
    `UPDATE executions SET handled_at = CASE WHEN $2 THEN now() ELSE NULL END, handled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
     WHERE id = ANY($1) AND status IN ('error','crashed') RETURNING id, workflow_id, client_id`, [executionIds, handled, actor.userId || null]);
  for (const r of rows) {
    await audit({ actorUserId: actor.userId || null, actorLabel: actor.label, source: actor.source, action: handled ? 'execution.handled' : 'execution.unhandled',
      targetType: 'execution', targetId: r.id, clientId: r.client_id, ip: actor.ip });
  }
  return rows.length;
}

/** Réactive les workflows dont la pause est terminée. */
export async function resumePausedWorkflows(actor: Actor) {
  const due = await q<{ id: string }>(`SELECT id FROM workflows WHERE paused_until IS NOT NULL AND paused_until <= now() AND NOT active AND deleted_at IS NULL`);
  let n = 0;
  for (const w of due) {
    try {
      await setWorkflowActive(actor, w.id, true, { reason: 'Fin de la pause programmée' });
      n++;
    } catch {
      await q('UPDATE workflows SET paused_until = now() + interval \'10 minutes\' WHERE id=$1', [w.id]);
    }
  }
  return n;
}
