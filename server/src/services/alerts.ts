import { config } from '../config.js';
import { one, q } from '../db.js';
import { categoryLabels, clientExplanations, type ErrorCategory } from './classify.js';
import { enqueue, escapeHtml, notifyClientUsers, notifyInApp } from './notify.js';
import { emitEvent } from './webhooks.js';
import { getSettings } from './settings.js';

export interface Rule {
  id: string; name: string; kind: string; client_id: string | null; workflow_id: string | null; threshold: number | null;
  window_hours: number; group_minutes: number; repeat_minutes: number; channels: string[]; enabled: boolean;
}

export const DEFAULT_RULES: Omit<Rule, 'id' | 'client_id' | 'workflow_id' | 'enabled'>[] = [
  { name: 'Échec d’exécution', kind: 'execution_failed', threshold: null, window_hours: 24, group_minutes: 15, repeat_minutes: 240, channels: ['app', 'telegram'] },
  { name: 'Workflow sans exécution', kind: 'workflow_inactive', threshold: 3, window_hours: 24, group_minutes: 15, repeat_minutes: 1440, channels: ['app', 'telegram'] },
  { name: 'Taux d’échec élevé', kind: 'failure_rate', threshold: 20, window_hours: 24, group_minutes: 15, repeat_minutes: 720, channels: ['app', 'telegram'] },
  { name: 'Synchronisation en panne', kind: 'sync_failed', threshold: 2, window_hours: 24, group_minutes: 15, repeat_minutes: 120, channels: ['app', 'telegram', 'email'] },
  { name: 'Budget IA dépassé', kind: 'llm_budget', threshold: 80, window_hours: 24, group_minutes: 15, repeat_minutes: 1440, channels: ['app', 'telegram', 'email'] },
];

export async function ensureDefaultRules() {
  const n = await one<{ n: number }>('SELECT count(*)::int n FROM alert_rules');
  if (n && n.n > 0) return;
  for (const r of DEFAULT_RULES) {
    await q(`INSERT INTO alert_rules(name, kind, threshold, window_hours, group_minutes, repeat_minutes, channels) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.name, r.kind, r.threshold, r.window_hours, r.group_minutes, r.repeat_minutes, r.channels]);
  }
}

async function rulesFor(kind: string): Promise<Rule[]> {
  return q<Rule>('SELECT * FROM alert_rules WHERE enabled AND kind=$1', [kind]);
}

/** Règle la plus spécifique applicable (workflow > client > globale). */
function pickRule(rules: Rule[], clientId: string | null, workflowId: string | null): Rule | null {
  return rules.find((r) => r.workflow_id && r.workflow_id === workflowId)
    ?? rules.find((r) => !r.workflow_id && r.client_id && r.client_id === clientId)
    ?? rules.find((r) => !r.workflow_id && !r.client_id)
    ?? null;
}

interface RaiseInput {
  rule: Rule; kind: string; dedupKey: string; title: string; message: string; severity?: 'info' | 'warning' | 'critical';
  clientId?: string | null; workflowId?: string | null; instanceId?: string | null; increment?: number;
}

/** Ouvre ou met à jour une alerte (regroupement par clé), puis notifie si nécessaire. */
export async function raiseAlert(a: RaiseInput): Promise<number> {
  const existing = await one<any>(`SELECT * FROM alerts WHERE dedup_key=$1 AND status <> 'resolved'`, [a.dedupKey]);
  let alert: any;
  if (existing) {
    alert = await one(`UPDATE alerts SET occurrences = occurrences + $2, last_seen_at = now(), message=$3, title=$4 WHERE id=$1 RETURNING *`,
      [existing.id, a.increment ?? 0, a.message, a.title]);
  } else {
    alert = await one(`INSERT INTO alerts(rule_id, kind, dedup_key, client_id, workflow_id, instance_id, severity, title, message, occurrences)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.rule.id, a.kind, a.dedupKey, a.clientId ?? null, a.workflowId ?? null, a.instanceId ?? null, a.severity ?? 'warning', a.title, a.message, Math.max(1, a.increment ?? 1)]);
    await emitEvent('alert.opened', { alertId: alert.id, kind: a.kind, title: a.title, message: a.message, workflowId: a.workflowId ?? null }, a.clientId);
  }
  await maybeNotify(alert, a.rule);
  return alert.id;
}

export async function resolveAlerts(dedupPrefix: string, exceptKeys: string[] = []) {
  await q(`UPDATE alerts SET status='resolved', resolved_at=now() WHERE status <> 'resolved' AND dedup_key LIKE $1 || '%' AND NOT (dedup_key = ANY($2))`,
    [dedupPrefix, exceptKeys]);
}

/**
 * Anti-bruit :
 *  - première notification immédiate ;
 *  - nouvelles occurrences regroupées, notifiées au plus une fois par « group_minutes » ;
 *  - alerte persistante non acquittée rappelée après « repeat_minutes ».
 */
async function maybeNotify(alert: any, rule: Rule) {
  const now = Date.now();
  const last = alert.last_notified_at ? new Date(alert.last_notified_at).getTime() : null;
  let reason: 'first' | 'grouped' | 'repeat' | null = null;
  if (last === null) reason = 'first';
  else if (alert.occurrences > alert.notified_occurrences && now - last >= rule.group_minutes * 60000) reason = 'grouped';
  else if (alert.status === 'open' && now - last >= rule.repeat_minutes * 60000) reason = 'repeat';
  if (!reason) return;

  const newCount = alert.occurrences - alert.notified_occurrences;
  const prefix = reason === 'grouped' ? `${newCount} nouvelle(s) occurrence(s) — ` : reason === 'repeat' ? 'Rappel — ' : '';
  const title = `${prefix}${alert.title}`;
  const link = alert.workflow_id ? `/agence/workflows/${alert.workflow_id}` : alert.client_id ? `/agence/clients/${alert.client_id}` : '/agence/alertes';
  if (rule.channels.includes('app')) await notifyInApp({ title, body: alert.message, link, clientId: alert.client_id });
  if (rule.channels.includes('telegram') && config.telegram.adminChatId) {
    const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟠' : 'ℹ️';
    await enqueue({ channel: 'telegram', recipient: config.telegram.adminChatId,
      body: `${icon} <b>${escapeHtml(title)}</b>\n${escapeHtml(alert.message)}\n${config.publicUrl}${link}`, bypassQuiet: alert.severity === 'critical' });
  }
  if (rule.channels.includes('email')) {
    const admins = await q<{ email: string }>(`SELECT email FROM users WHERE role='admin' AND disabled_at IS NULL AND notify_email`);
    const to = new Set([config.adminEmail, ...admins.map((x) => x.email)].filter(Boolean));
    for (const r of to) await enqueue({ channel: 'email', recipient: r, subject: `[${config.brand.productName}] ${title}`, body: `${alert.message}\n${config.publicUrl}${link}` });
  }
  await q('UPDATE alerts SET last_notified_at=now(), notified_occurrences=occurrences WHERE id=$1', [alert.id]);
}

/** Relance les notifications groupées / rappels en attente (appelé par le planificateur). */
export async function flushAlertNotifications() {
  const open = await q<any>(`SELECT a.*, r.name AS rule_name, r.threshold AS rule_threshold, r.window_hours AS rule_window_hours,
                                    r.group_minutes AS rule_group_minutes, r.repeat_minutes AS rule_repeat_minutes, r.channels AS rule_channels
                             FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
                             WHERE a.status <> 'resolved' AND r.enabled`);
  for (const a of open) {
    const rule: Rule = { id: a.rule_id, name: a.rule_name, kind: a.kind, client_id: null, workflow_id: null, threshold: a.rule_threshold,
      window_hours: a.rule_window_hours, group_minutes: a.rule_group_minutes, repeat_minutes: a.rule_repeat_minutes, channels: a.rule_channels, enabled: true };
    await maybeNotify(a, rule);
  }
}

// ------------------------------------------------------------------ déclencheurs

export async function onExecutionsFailed(executionIds: number[]) {
  if (!executionIds.length) return;
  const rules = await rulesFor('execution_failed');
  const rows = await q<any>(`
    SELECT e.id, e.n8n_execution_id, e.error_node, e.error_message, e.error_category, e.started_at, e.client_id,
           w.id AS workflow_id, w.name AS workflow_name, COALESCE(w.display_name, w.name) AS display_name, w.client_visible,
           c.name AS client_name
    FROM executions e JOIN workflows w ON w.id=e.workflow_id LEFT JOIN clients c ON c.id=e.client_id
    WHERE e.id = ANY($1) ORDER BY e.started_at`, [executionIds]);
  const byWorkflow = new Map<string, any[]>();
  for (const r of rows) byWorkflow.set(r.workflow_id, [...(byWorkflow.get(r.workflow_id) ?? []), r]);
  for (const [workflowId, list] of byWorkflow) {
    const lastErr = list[list.length - 1];
    for (const e of list) {
      await emitEvent('execution.failed', {
        executionId: e.id, n8nExecutionId: e.n8n_execution_id, workflowId, workflowName: e.workflow_name,
        errorNode: e.error_node, errorCategory: e.error_category, startedAt: e.started_at,
      }, e.client_id);
    }
    const rule = pickRule(rules, lastErr.client_id, workflowId);
    if (!rule) continue;
    const cat = (lastErr.error_category ?? 'logic') as ErrorCategory;
    const who = lastErr.client_name ? `${lastErr.client_name} · ` : '';
    const alertId = await raiseAlert({
      rule, kind: 'execution_failed', dedupKey: `execution_failed:${workflowId}`,
      title: `Échec : ${who}${lastErr.workflow_name}`,
      message: `${list.length > 1 ? `${list.length} échecs. ` : ''}Nœud : ${lastErr.error_node ?? 'inconnu'} · ${categoryLabels[cat]}\n${(lastErr.error_message ?? '').slice(0, 300)}`,
      severity: 'warning', clientId: lastErr.client_id, workflowId, increment: list.length,
    });
    // le client est prévenu (vocabulaire simple) une fois par alerte
    if (lastErr.client_id && lastErr.client_visible) {
      const a = await one<{ occurrences: number }>('SELECT occurrences FROM alerts WHERE id=$1', [alertId]);
      if (a && a.occurrences === list.length) {
        await notifyClientUsers(lastErr.client_id, {
          kind: 'error',
          title: `Un incident a touché « ${lastErr.display_name} »`,
          body: `${clientExplanations[cat]} Nous sommes prévenus automatiquement.`,
          link: `/portail/automatisations/${workflowId}`,
        });
      }
    }
  }
}

/** Résout l'alerte d'échec d'un workflow dès qu'une exécution réussit après le dernier échec. */
export async function autoResolveRecovered() {
  await q(`
    UPDATE alerts a SET status='resolved', resolved_at=now()
    WHERE a.kind='execution_failed' AND a.status <> 'resolved' AND EXISTS (
      SELECT 1 FROM executions e WHERE e.workflow_id = a.workflow_id AND e.status='success' AND e.started_at > a.last_seen_at)`);
}

export async function onSyncResult(instanceId: string, ok: boolean, error?: string) {
  const key = `sync_failed:${instanceId}`;
  if (ok) return resolveAlerts(key);
  const rule = pickRule(await rulesFor('sync_failed'), null, null);
  if (!rule) return;
  const inst = await one<{ name: string; consecutive_sync_failures: number }>('SELECT name, consecutive_sync_failures FROM instances WHERE id=$1', [instanceId]);
  if (!inst || inst.consecutive_sync_failures < Number(rule.threshold ?? 1)) return;
  await raiseAlert({
    rule, kind: 'sync_failed', dedupKey: key, instanceId, severity: 'critical', increment: 1,
    title: `Synchronisation en panne : ${inst.name}`,
    message: `${inst.consecutive_sync_failures} échecs consécutifs. Dernière erreur : ${error ?? 'inconnue'}`,
  });
}

/** Évaluation périodique des règles d'état (inactivité, taux d'échec, budget). */
export async function evaluatePeriodic() {
  await autoResolveRecovered();
  await evaluateInactivity();
  await evaluateFailureRate();
  await evaluateBudgets();
}

async function evaluateInactivity() {
  const rules = await rulesFor('workflow_inactive');
  if (!rules.length) return;
  const wfs = await q<any>(`
    SELECT w.id, w.name, w.client_id, w.last_execution_at, c.name client_name, c.inactivity_days
    FROM workflows w LEFT JOIN clients c ON c.id=w.client_id
    WHERE w.active AND w.deleted_at IS NULL`);
  const firing: string[] = [];
  for (const w of wfs) {
    const rule = pickRule(rules, w.client_id, w.id);
    if (!rule) continue;
    const days = Number(rule.client_id || rule.workflow_id ? rule.threshold : (w.inactivity_days ?? rule.threshold ?? 3));
    const since = w.last_execution_at ? (Date.now() - new Date(w.last_execution_at).getTime()) / 86400000 : Infinity;
    if (since < days) continue;
    const key = `workflow_inactive:${w.id}`;
    firing.push(key);
    await raiseAlert({
      rule, kind: 'workflow_inactive', dedupKey: key, clientId: w.client_id, workflowId: w.id,
      title: `Aucune exécution depuis ${Number.isFinite(since) ? Math.floor(since) : '—'} jour(s) : ${w.name}`,
      message: `${w.client_name ? `Client : ${w.client_name}. ` : ''}Le workflow est actif mais ne s’est pas exécuté depuis ${days} jour(s) ou plus.`,
    });
  }
  await resolveAlerts('workflow_inactive:', firing);
}

async function evaluateFailureRate() {
  const rules = await rulesFor('failure_rate');
  if (!rules.length) return;
  const s = await getSettings();
  const maxWindow = Math.max(...rules.map((r) => r.window_hours));
  const stats = await q<any>(`
    SELECT w.id, w.name, w.client_id, c.name client_name,
      e.started_at, e.status
    FROM executions e JOIN workflows w ON w.id=e.workflow_id LEFT JOIN clients c ON c.id=w.client_id
    WHERE e.started_at > now() - ($1 * interval '1 hour') AND e.status IN ('success','error','crashed') AND w.deleted_at IS NULL`, [maxWindow]);
  const byWf = new Map<string, any[]>();
  for (const r of stats) byWf.set(r.id, [...(byWf.get(r.id) ?? []), r]);
  const firing: string[] = [];
  for (const [id, list] of byWf) {
    const rule = pickRule(rules, list[0].client_id, id);
    if (!rule) continue;
    const since = Date.now() - rule.window_hours * 3600000;
    const inWin = list.filter((r) => new Date(r.started_at).getTime() >= since);
    if (inWin.length < s.atRisk.minExecutions) continue;
    const failed = inWin.filter((r) => r.status !== 'success').length;
    const pct = (failed / inWin.length) * 100;
    if (pct <= Number(rule.threshold ?? 20)) continue;
    const key = `failure_rate:${id}`;
    firing.push(key);
    await raiseAlert({
      rule, kind: 'failure_rate', dedupKey: key, clientId: list[0].client_id, workflowId: id, severity: pct >= 50 ? 'critical' : 'warning',
      title: `Taux d’échec ${Math.round(pct)} % : ${list[0].name}`,
      message: `${failed} échec(s) sur ${inWin.length} exécution(s) en ${rule.window_hours} h (seuil ${rule.threshold} %).`,
    });
  }
  await resolveAlerts('failure_rate:', firing);
}

async function evaluateBudgets() {
  const rules = await rulesFor('llm_budget');
  if (!rules.length) return;
  const rows = await q<any>(`
    SELECT c.id, c.name, c.monthly_budget_usd budget, COALESCE(sum(u.cost_usd),0) spent
    FROM clients c LEFT JOIN llm_usage u ON u.client_id=c.id AND u.day >= date_trunc('month', now())::date
    WHERE c.monthly_budget_usd > 0 AND c.archived_at IS NULL GROUP BY c.id`);
  const firing: string[] = [];
  for (const c of rows) {
    const rule = pickRule(rules, c.id, null);
    if (!rule) continue;
    const pct = (c.spent / c.budget) * 100;
    if (pct < Number(rule.threshold ?? 80)) continue;
    const key = `llm_budget:${c.id}:${new Date().toISOString().slice(0, 7)}`;
    firing.push(key);
    await raiseAlert({
      rule, kind: 'llm_budget', dedupKey: key, clientId: c.id, severity: pct >= 100 ? 'critical' : 'warning',
      title: `Budget IA ${Math.round(pct)} % : ${c.name}`,
      message: `Dépense du mois : ${c.spent.toFixed(2)} $US sur un budget de ${Number(c.budget).toFixed(2)} $US.`,
    });
  }
  await resolveAlerts('llm_budget:', firing);
}
