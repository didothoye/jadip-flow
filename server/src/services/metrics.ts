import { config } from '../config.js';
import { q, one } from '../db.js';
import { getSettings } from './settings.js';

const TZ = () => config.timezone;
const OK = `status = 'success'`;
const FAIL = `status IN ('error','crashed')`;

/** Début du jour local courant, en SQL. */
const todayStart = `(date_trunc('day', now() AT TIME ZONE $TZ) AT TIME ZONE $TZ)`;
const sql = (s: string) => s.replaceAll('$TZ', `'${TZ().replace(/'/g, '')}'`);

export async function fleetOverview() {
  const counts = await one<any>(sql(`
    SELECT
      (SELECT count(*)::int FROM instances) instances,
      (SELECT count(*)::int FROM instances WHERE health_status <> 'ok') instances_unhealthy,
      (SELECT count(*)::int FROM clients WHERE archived_at IS NULL) clients,
      (SELECT count(*)::int FROM workflows WHERE deleted_at IS NULL AND active) workflows_active,
      (SELECT count(*)::int FROM workflows WHERE deleted_at IS NULL AND NOT active) workflows_inactive,
      (SELECT count(*)::int FROM workflows WHERE deleted_at IS NULL AND client_id IS NULL) workflows_unassigned,
      (SELECT count(*)::int FROM executions WHERE started_at >= ${todayStart}) exec_today,
      (SELECT count(*)::int FROM executions WHERE started_at >= ${todayStart} AND ${FAIL}) fail_today,
      (SELECT count(*)::int FROM executions WHERE started_at >= now() - interval '7 days') exec_week,
      (SELECT count(*)::int FROM executions WHERE started_at >= now() - interval '7 days' AND ${OK}) ok_week,
      (SELECT count(*)::int FROM executions WHERE started_at >= now() - interval '7 days' AND ${FAIL}) fail_week,
      (SELECT count(*)::int FROM alerts WHERE status='open') alerts_open,
      (SELECT COALESCE(sum(cost_usd),0) FROM llm_usage WHERE day >= date_trunc('month', now())::date) llm_month_usd
  `));
  const finishedWeek = counts.ok_week + counts.fail_week;
  return { ...counts, success_rate_week: finishedWeek ? counts.ok_week / finishedWeek : null };
}

export async function recentErrors(opts: { clientId?: string | null; workflowId?: string; category?: string; unhandledOnly?: boolean; limit?: number; before?: number; visibleOnly?: boolean } = {}) {
  const params: unknown[] = [];
  const where = [`e.status IN ('error','crashed')`];
  if (opts.clientId) { params.push(opts.clientId); where.push(`e.client_id = $${params.length}`); }
  if (opts.workflowId) { params.push(opts.workflowId); where.push(`e.workflow_id = $${params.length}`); }
  if (opts.category) { params.push(opts.category); where.push(`e.error_category = $${params.length}`); }
  if (opts.unhandledOnly) where.push('e.handled_at IS NULL');
  if (opts.visibleOnly) where.push('w.client_visible');
  if (opts.before) { params.push(opts.before); where.push(`e.id < $${params.length}`); }
  params.push(Math.min(opts.limit ?? 50, 500));
  return q<any>(`
    SELECT e.id, e.n8n_execution_id, e.status, e.started_at, e.stopped_at, e.duration_ms, e.error_node, e.error_message, e.error_category,
           e.handled_at, e.workflow_id, w.name workflow_name, COALESCE(w.display_name, w.name) workflow_display_name, e.client_id, c.name client_name,
           e.instance_id, i.name instance_name
    FROM executions e JOIN workflows w ON w.id=e.workflow_id LEFT JOIN clients c ON c.id=e.client_id JOIN instances i ON i.id=e.instance_id
    WHERE ${where.join(' AND ')} ORDER BY e.started_at DESC NULLS LAST, e.id DESC LIMIT $${params.length}`, params);
}

export async function errorCategoryCounts(days = 7, clientId?: string | null) {
  return q<{ category: string; n: number }>(`
    SELECT COALESCE(error_category,'logic') category, count(*)::int n FROM executions
    WHERE status IN ('error','crashed') AND started_at >= now() - ($1 * interval '1 day') AND ($2::uuid IS NULL OR client_id=$2)
    GROUP BY 1 ORDER BY 2 DESC`, [days, clientId ?? null]);
}

/** Synthèse par client (vue flotte et liste des clients), avec détection « à risque ». */
export async function clientsSummary(clientId?: string) {
  const s = await getSettings();
  const rows = await q<any>(sql(`
    SELECT c.id, c.code, c.name, c.is_internal, c.logo_path, c.monthly_budget_usd, c.monthly_fee_usd, c.inactivity_days, c.archived_at,
      (SELECT count(*)::int FROM workflows w WHERE w.client_id=c.id AND w.deleted_at IS NULL) workflows,
      (SELECT count(*)::int FROM workflows w WHERE w.client_id=c.id AND w.deleted_at IS NULL AND w.active) workflows_active,
      (SELECT max(started_at) FROM executions e WHERE e.client_id=c.id) last_execution_at,
      x.exec_30d, x.ok_30d, x.fail_30d, y.exec_7d, y.fail_7d,
      COALESCE((SELECT sum(w.minutes_saved_per_execution * k.n) FROM workflows w JOIN (
         SELECT workflow_id, count(*) n FROM executions WHERE client_id=c.id AND status='success'
           AND started_at >= (date_trunc('month', now() AT TIME ZONE $TZ) AT TIME ZONE $TZ) GROUP BY workflow_id) k ON k.workflow_id=w.id),0) minutes_saved_month,
      COALESCE((SELECT sum(cost_usd) FROM llm_usage u WHERE u.client_id=c.id AND u.day >= date_trunc('month', now())::date),0) llm_month_usd,
      (SELECT count(*)::int FROM alerts a WHERE a.client_id=c.id AND a.status='open') alerts_open,
      (SELECT count(*)::int FROM tickets t WHERE t.client_id=c.id AND t.status IN ('new','in_progress')) tickets_open
    FROM clients c
    LEFT JOIN LATERAL (SELECT count(*)::int exec_30d, count(*) FILTER (WHERE ${OK})::int ok_30d, count(*) FILTER (WHERE ${FAIL})::int fail_30d
                       FROM executions e WHERE e.client_id=c.id AND e.started_at >= now() - interval '30 days') x ON true
    LEFT JOIN LATERAL (SELECT count(*)::int exec_7d, count(*) FILTER (WHERE ${FAIL})::int fail_7d
                       FROM executions e WHERE e.client_id=c.id AND e.started_at >= now() - interval '7 days') y ON true
    WHERE ($1::uuid IS NULL OR c.id=$1) ORDER BY c.is_internal, c.name`), [clientId ?? null]);
  return rows.map((r) => {
    const finished = r.ok_30d + r.fail_30d;
    const risks: string[] = [];
    const inactivityDays = r.inactivity_days ?? s.atRisk.inactivityDays;
    const since = r.last_execution_at ? (Date.now() - new Date(r.last_execution_at).getTime()) / 86400000 : null;
    if (r.workflows_active > 0 && (since === null || since > inactivityDays)) risks.push(`Aucune exécution depuis ${since === null ? 'toujours' : `${Math.floor(since)} jour(s)`}`);
    if (r.exec_7d >= s.atRisk.minExecutions && (r.fail_7d / r.exec_7d) * 100 > s.atRisk.failureRatePct) risks.push(`Taux d’échec ${Math.round((r.fail_7d / r.exec_7d) * 100)} % sur 7 jours`);
    if (r.monthly_budget_usd && r.llm_month_usd >= r.monthly_budget_usd) risks.push('Budget IA dépassé');
    return { ...r, success_rate_30d: finished ? r.ok_30d / finished : null, at_risk: risks.length > 0, risks };
  });
}

export async function dailySeries(opts: { clientId?: string | null; workflowId?: string | null; days?: number }) {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 366);
  return q<{ day: string; total: number; success: number; failed: number }>(sql(`
    WITH d AS (SELECT generate_series((now() AT TIME ZONE $TZ)::date - ($1::int - 1), (now() AT TIME ZONE $TZ)::date, '1 day')::date AS day)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
      count(e.id)::int total,
      count(e.id) FILTER (WHERE e.${OK})::int success,
      count(e.id) FILTER (WHERE e.status IN ('error','crashed'))::int failed
    FROM d LEFT JOIN executions e ON (e.started_at AT TIME ZONE $TZ)::date = d.day
      AND e.started_at >= now() - (($1::int + 1) * interval '1 day')
      AND ($2::uuid IS NULL OR e.client_id = $2) AND ($3::uuid IS NULL OR e.workflow_id = $3)
    GROUP BY d.day ORDER BY d.day`), [days, opts.clientId ?? null, opts.workflowId ?? null]);
}

/** Statistiques par workflow (liste agence, fiche client, cartes du portail client). */
export async function workflowsWithStats(filter: { clientId?: string | null; instanceId?: string; workflowId?: string; includeDeleted?: boolean; visibleOnly?: boolean; search?: string; unassigned?: boolean }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (!filter.includeDeleted) where.push('w.deleted_at IS NULL');
  if (filter.clientId) { params.push(filter.clientId); where.push(`w.client_id = $${params.length}`); }
  if (filter.unassigned) where.push('w.client_id IS NULL');
  if (filter.instanceId) { params.push(filter.instanceId); where.push(`w.instance_id = $${params.length}`); }
  if (filter.workflowId) { params.push(filter.workflowId); where.push(`w.id = $${params.length}`); }
  if (filter.visibleOnly) where.push('w.client_visible');
  if (filter.search) { params.push(`%${filter.search}%`); where.push(`(w.name ILIKE $${params.length} OR w.display_name ILIKE $${params.length})`); }
  return q<any>(sql(`
    SELECT w.id, w.instance_id, i.name instance_name, COALESCE(i.public_url, i.base_url) instance_url, w.n8n_id, w.name, w.display_name, w.description, w.active, w.tags,
      w.client_id, c.name client_name, w.client_assignment, w.is_locked, w.client_visible, w.client_can_toggle, w.client_can_retry,
      w.minutes_saved_per_execution, w.cost_per_execution_usd, w.paused_until, w.deleted_at, w.n8n_updated_at, w.last_execution_at, w.first_seen_at,
      s.exec_30d, s.ok_30d, s.fail_30d, s.avg_ms, m.ok_month,
      (SELECT e.status FROM executions e WHERE e.workflow_id=w.id ORDER BY e.started_at DESC NULLS LAST LIMIT 1) last_status,
      (SELECT count(*)::int FROM executions e WHERE e.workflow_id=w.id AND e.status IN ('error','crashed') AND e.handled_at IS NULL AND e.started_at >= now() - interval '7 days') unhandled_errors_7d
    FROM workflows w JOIN instances i ON i.id=w.instance_id LEFT JOIN clients c ON c.id=w.client_id
    LEFT JOIN LATERAL (SELECT count(*)::int exec_30d, count(*) FILTER (WHERE ${OK})::int ok_30d, count(*) FILTER (WHERE ${FAIL})::int fail_30d,
                              avg(duration_ms)::int avg_ms
                       FROM executions e WHERE e.workflow_id=w.id AND e.started_at >= now() - interval '30 days') s ON true
    LEFT JOIN LATERAL (SELECT count(*)::int ok_month FROM executions e WHERE e.workflow_id=w.id AND e.${OK}
                       AND e.started_at >= (date_trunc('month', now() AT TIME ZONE $TZ) AT TIME ZONE $TZ)) m ON true
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.name NULLS FIRST, COALESCE(w.display_name, w.name)`), params).then((rows) => rows.map((r) => {
      const fin = r.ok_30d + r.fail_30d;
      return { ...r, success_rate_30d: fin ? r.ok_30d / fin : null, minutes_saved_month: r.ok_month * Number(r.minutes_saved_per_execution) };
    }));
}

export interface ExecFilter {
  clientId?: string | null; workflowId?: string; instanceId?: string; status?: string; category?: string;
  from?: string; to?: string; cursor?: string; limit?: number; visibleOnly?: boolean;
}

/** Liste d'exécutions paginée par curseur (tri stable started_at, id) — tient 100 000+ lignes. */
export async function listExecutions(f: ExecFilter) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
  if (f.clientId) add('e.client_id = ?', f.clientId);
  if (f.workflowId) add('e.workflow_id = ?', f.workflowId);
  if (f.instanceId) add('e.instance_id = ?', f.instanceId);
  if (f.status === 'failed') where.push(`e.status IN ('error','crashed')`);
  else if (f.status) add('e.status = ?', f.status);
  if (f.category) add('e.error_category = ?', f.category);
  if (f.from) add('e.started_at >= ?', f.from);
  if (f.to) add('e.started_at < ?', f.to);
  if (f.visibleOnly) where.push('w.client_visible');
  if (f.cursor) {
    const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|');
    params.push(ts, Number(id));
    where.push(`(e.started_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  params.push(limit + 1);
  const rows = await q<any>(`
    SELECT e.id, e.n8n_execution_id, e.status, e.mode, e.started_at, e.stopped_at, e.duration_ms, e.error_node, e.error_message, e.error_category,
           e.retry_of, e.handled_at, e.workflow_id, COALESCE(w.display_name, w.name) workflow_display_name, w.name workflow_name, e.client_id
    FROM executions e JOIN workflows w ON w.id = e.workflow_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.started_at DESC, e.id DESC LIMIT $${params.length}`, params);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? Buffer.from(`${new Date(last.started_at).toISOString()}|${last.id}`).toString('base64url') : null;
  return { items, nextCursor };
}
