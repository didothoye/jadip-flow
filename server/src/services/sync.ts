import { one, q, tx } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { N8nClient, type N8nExecution } from '../n8n/client.js';
import { classifyError } from './classify.js';
import { getSettings } from './settings.js';
import { onExecutionsFailed, onSyncResult } from './alerts.js';
import { notifyInApp } from './notify.js';

export interface Instance {
  id: string; name: string; base_url: string; public_url: string | null; api_key_enc: string;
  sync_enabled: boolean; sync_interval_minutes: number; retention_days: number;
  executions_cursor_started_at: Date | null; last_sync_at: Date | null; consecutive_sync_failures: number;
}

export const clientFor = (i: Pick<Instance, 'base_url' | 'api_key_enc'>) => new N8nClient(i.base_url, decrypt(i.api_key_enc));

const FAILED = new Set(['error', 'crashed']);
const OVERLAP_MS = 6 * 3600 * 1000;
const running = new Set<string>();

export interface SyncSummary {
  status: 'success' | 'error' | 'skipped';
  workflowsSeen: number; created: number; renamed: number; deleted: number; executionsImported: number;
  durationMs: number; error?: string;
}

/** Détermine le client d'un workflow d'après ses étiquettes « client:<code> ». */
export function clientCodeFromTags(tags: string[]): string | null {
  for (const t of tags) {
    const m = /^client\s*:\s*([a-z0-9][a-z0-9-]*)$/i.exec(t.trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export async function syncInstance(instanceId: string, trigger: 'schedule' | 'manual' = 'manual'): Promise<SyncSummary> {
  if (running.has(instanceId)) {
    return { status: 'skipped', workflowsSeen: 0, created: 0, renamed: 0, deleted: 0, executionsImported: 0, durationMs: 0 };
  }
  running.add(instanceId);
  const t0 = Date.now();
  const inst = await one<Instance>('SELECT * FROM instances WHERE id=$1', [instanceId]);
  if (!inst) { running.delete(instanceId); throw new Error('Instance introuvable'); }
  const run = await one<{ id: number }>(`INSERT INTO sync_runs(instance_id, trigger, status) VALUES ($1,$2,'running') RETURNING id`, [instanceId, trigger]);
  const s: SyncSummary = { status: 'success', workflowsSeen: 0, created: 0, renamed: 0, deleted: 0, executionsImported: 0, durationMs: 0 };
  try {
    const client = clientFor(inst);
    const settings = await getSettings();
    await syncWorkflows(inst, client, s);
    const failed = await syncExecutions(inst, client, s, settings.sync.maxInitialExecutions);
    await fetchErrorDetails(inst, client, settings.sync.errorDetailsPerSync);
    s.durationMs = Date.now() - t0;
    await q(`UPDATE sync_runs SET status='success', finished_at=now(), duration_ms=$2, workflows_seen=$3, workflows_created=$4,
             workflows_renamed=$5, workflows_deleted=$6, executions_imported=$7 WHERE id=$1`,
      [run!.id, s.durationMs, s.workflowsSeen, s.created, s.renamed, s.deleted, s.executionsImported]);
    await q(`UPDATE instances SET last_sync_at=now(), last_sync_status='success', consecutive_sync_failures=0,
             health_status='ok', health_message='Synchronisation réussie', health_checked_at=now() WHERE id=$1`, [instanceId]);
    if (inst.last_sync_at && (s.created || s.deleted || s.renamed)) {
      // changements détectés après la première synchronisation : prévenir l'agence (dans l'application)
      const parts = [s.created && `${s.created} nouveau(x)`, s.renamed && `${s.renamed} renommé(s)`, s.deleted && `${s.deleted} supprimé(s)`].filter(Boolean);
      await notifyInApp({ title: `Workflows modifiés sur ${inst.name}`, body: `${parts.join(', ')}. Pensez à rattacher les nouveaux workflows à un client.`, link: '/agence/workflows?non_rattaches=1' });
    }
    if (failed.length) await onExecutionsFailed(failed);
    await onSyncResult(instanceId, true);
  } catch (e: any) {
    s.status = 'error';
    s.error = String(e?.message ?? e).slice(0, 500);
    s.durationMs = Date.now() - t0;
    await q(`UPDATE sync_runs SET status='error', finished_at=now(), duration_ms=$2, error_message=$3 WHERE id=$1`, [run!.id, s.durationMs, s.error]);
    await q(`UPDATE instances SET last_sync_at=now(), last_sync_status='error', consecutive_sync_failures=consecutive_sync_failures+1,
             health_status = CASE WHEN consecutive_sync_failures+1 >= 3 THEN 'down' ELSE 'degraded' END,
             health_message=$2, health_checked_at=now() WHERE id=$1`, [instanceId, s.error]);
    await onSyncResult(instanceId, false, s.error);
  } finally {
    running.delete(instanceId);
  }
  return s;
}

async function syncWorkflows(inst: Instance, client: N8nClient, s: SyncSummary) {
  const clients = new Map((await q<{ id: string; code: string }>('SELECT id, code FROM clients WHERE archived_at IS NULL')).map((c) => [c.code, c.id]));
  const seen = new Set<string>();
  for await (const w of client.workflows()) {
    seen.add(w.id);
    s.workflowsSeen++;
    const tags = (w.tags ?? []).map((t) => t.name);
    const code = clientCodeFromTags(tags);
    const tagClient = code ? clients.get(code) ?? null : null;
    await tx(async (c) => {
      const cur = (await c.query('SELECT * FROM workflows WHERE instance_id=$1 AND n8n_id=$2 FOR UPDATE', [inst.id, w.id])).rows[0];
      if (!cur) {
        const ins = await c.query(
          `INSERT INTO workflows(instance_id, n8n_id, name, active, tags, n8n_updated_at, n8n_created_at, is_archived_in_n8n, client_id, client_assignment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [inst.id, w.id, w.name, w.active, tags, w.updatedAt ?? null, w.createdAt ?? null, !!w.isArchived, tagClient, tagClient ? 'tag' : 'none']);
        await c.query(`INSERT INTO workflow_events(workflow_id, kind, detail) VALUES ($1,'created',$2)`, [ins.rows[0].id, { name: w.name }]);
        s.created++;
        return;
      }
      const events: [string, object][] = [];
      if (cur.name !== w.name) { events.push(['renamed', { from: cur.name, to: w.name }]); s.renamed++; }
      if (cur.active !== w.active) events.push([w.active ? 'activated' : 'deactivated', { by: 'n8n' }]);
      if (cur.deleted_at) events.push(['restored', {}]);
      let clientId = cur.client_id;
      let assignment = cur.client_assignment;
      if (cur.client_assignment !== 'manual') {
        const next = tagClient;
        if (next !== cur.client_id) events.push(['assigned', { clientId: next, via: 'tag' }]);
        clientId = next;
        assignment = next ? 'tag' : 'none';
      }
      await c.query(
        `UPDATE workflows SET name=$2, active=$3, tags=$4, n8n_updated_at=$5, is_archived_in_n8n=$6, client_id=$7, client_assignment=$8,
                last_seen_at=now(), deleted_at=NULL, updated_at=now(),
                paused_until = CASE WHEN $3 THEN NULL ELSE paused_until END
         WHERE id=$1`,
        [cur.id, w.name, w.active, tags, w.updatedAt ?? null, !!w.isArchived, clientId, assignment]);
      if (clientId !== cur.client_id) await c.query('UPDATE executions SET client_id=$2 WHERE workflow_id=$1', [cur.id, clientId]);
      for (const [kind, detail] of events) await c.query('INSERT INTO workflow_events(workflow_id, kind, detail) VALUES ($1,$2,$3)', [cur.id, kind, detail]);
    });
  }
  const gone = await q<{ id: string; name: string }>(
    `UPDATE workflows SET deleted_at=now(), active=false, updated_at=now() WHERE instance_id=$1 AND deleted_at IS NULL AND NOT (n8n_id = ANY($2)) RETURNING id, name`,
    [inst.id, [...seen]]);
  for (const g of gone) await q(`INSERT INTO workflow_events(workflow_id, kind, detail) VALUES ($1,'deleted',$2)`, [g.id, { name: g.name }]);
  s.deleted = gone.length;
}

interface Row {
  workflowId: string; clientId: string | null; n8nId: string; status: string; mode: string | null;
  startedAt: string | null; stoppedAt: string | null; durationMs: number | null; retryOf: string | null; retrySuccessId: string | null;
}

async function syncExecutions(inst: Instance, client: N8nClient, s: SyncSummary, maxInitial: number): Promise<number[]> {
  const wfs = new Map((await q<{ id: string; n8n_id: string; client_id: string | null }>(
    'SELECT id, n8n_id, client_id FROM workflows WHERE instance_id=$1', [inst.id])).map((w) => [w.n8n_id, w]));
  const retentionBound = Date.now() - inst.retention_days * 86400000;
  const cursor = inst.executions_cursor_started_at ? new Date(inst.executions_cursor_started_at).getTime() : null;
  const stopBefore = Math.max(retentionBound, cursor ? cursor - OVERLAP_MS : 0);
  // les exécutions encore en cours sont revues à chaque synchronisation
  const oldestPending = await one<{ t: Date | null }>(
    `SELECT min(started_at) t FROM executions WHERE instance_id=$1 AND status IN ('running','waiting','new') AND started_at > now() - interval '7 days'`, [inst.id]);
  const bound = oldestPending?.t ? Math.min(stopBefore, new Date(oldestPending.t).getTime() - 1000) : stopBefore;

  let batch: Row[] = [];
  let count = 0;
  let maxFinished = cursor ?? 0;
  const failedIds: number[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const r = await upsertExecutions(inst.id, batch);
    failedIds.push(...r.newlyFailed);
    s.executionsImported += r.inserted;
    batch = [];
  };
  for await (const e of client.executions()) {
    const started = e.startedAt ? new Date(e.startedAt).getTime() : null;
    if (started !== null && started < bound) break;
    if (!cursor && count >= maxInitial) break;
    count++;
    const wf = wfs.get(String(e.workflowId));
    if (!wf) continue; // workflow inconnu (supprimé avant la première synchronisation)
    batch.push(toRow(e, wf.id, wf.client_id));
    const status = normalizeStatus(e);
    if (started && !['running', 'waiting', 'new'].includes(status)) maxFinished = Math.max(maxFinished, started);
    if (batch.length >= 500) await flush();
  }
  await flush();
  if (maxFinished) await q('UPDATE instances SET executions_cursor_started_at=$2 WHERE id=$1', [inst.id, new Date(maxFinished)]);
  await q(`UPDATE workflows w SET last_execution_at = x.m FROM (
             SELECT workflow_id, max(started_at) m FROM executions WHERE instance_id=$1 GROUP BY workflow_id) x
           WHERE x.workflow_id = w.id AND (w.last_execution_at IS NULL OR w.last_execution_at < x.m)`, [inst.id]);
  return failedIds;
}

function normalizeStatus(e: N8nExecution): string {
  if (e.status) return e.status === 'failed' ? 'error' : e.status;
  if (e.finished) return 'success';
  return e.stoppedAt ? 'error' : 'running';
}

function toRow(e: N8nExecution, workflowId: string, clientId: string | null): Row {
  const st = e.startedAt ?? e.stoppedAt ?? new Date().toISOString();
  const sp = e.stoppedAt ?? null;
  return {
    workflowId, clientId, n8nId: String(e.id), status: normalizeStatus(e), mode: e.mode ?? null,
    startedAt: st, stoppedAt: sp, durationMs: st && sp ? Math.max(0, new Date(sp).getTime() - new Date(st).getTime()) : null,
    retryOf: e.retryOf != null ? String(e.retryOf) : null, retrySuccessId: e.retrySuccessId != null ? String(e.retrySuccessId) : null,
  };
}

/** Insertion / mise à jour groupée ; retourne les exécutions nouvellement en échec. */
export async function upsertExecutions(instanceId: string, rows: Row[]): Promise<{ inserted: number; newlyFailed: number[] }> {
  const res = await q<{ id: number; status: string; inserted: boolean; was_failed: boolean }>(`
    WITH input AS (
      SELECT * FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::timestamptz[], $9::int[], $10::text[], $11::text[])
        AS t(workflow_id, client_id, n8n_execution_id, status, mode, started_at, stopped_at, duration_ms, retry_of, retry_success_id)
    ), prev AS (
      SELECT e.n8n_execution_id, e.status FROM executions e JOIN input i USING (n8n_execution_id) WHERE e.instance_id = $1
    )
    INSERT INTO executions(instance_id, workflow_id, client_id, n8n_execution_id, status, mode, started_at, stopped_at, duration_ms, retry_of, retry_success_id)
    SELECT $1, workflow_id, client_id, n8n_execution_id, status, mode, started_at, stopped_at, duration_ms, retry_of, retry_success_id FROM input
    ON CONFLICT (instance_id, n8n_execution_id) DO UPDATE SET
      status = EXCLUDED.status, stopped_at = EXCLUDED.stopped_at, duration_ms = EXCLUDED.duration_ms,
      retry_success_id = EXCLUDED.retry_success_id, workflow_id = EXCLUDED.workflow_id, client_id = EXCLUDED.client_id
    RETURNING id, status, (xmax = 0) AS inserted,
      COALESCE((SELECT p.status IN ('error','crashed') FROM prev p WHERE p.n8n_execution_id = executions.n8n_execution_id), false) AS was_failed`,
    [instanceId, rows.map((r) => r.workflowId), rows.map((r) => r.clientId), rows.map((r) => r.n8nId), rows.map((r) => r.status),
     rows.map((r) => r.mode), rows.map((r) => r.startedAt), rows.map((r) => r.stoppedAt), rows.map((r) => r.durationMs),
     rows.map((r) => r.retryOf), rows.map((r) => r.retrySuccessId)]);
  return {
    inserted: res.filter((r) => r.inserted).length,
    newlyFailed: res.filter((r) => FAILED.has(r.status) && !r.was_failed).map((r) => r.id),
  };
}

/** Récupère le nœud fautif et le message des échecs récents (sans aucune donnée traitée). */
async function fetchErrorDetails(inst: Instance, client: N8nClient, limit: number) {
  const rows = await q<{ id: number; n8n_execution_id: string }>(`
    SELECT id, n8n_execution_id FROM executions
    WHERE instance_id=$1 AND status IN ('error','crashed') AND error_message IS NULL AND error_category IS NULL
    ORDER BY started_at DESC LIMIT $2`, [inst.id, limit]);
  for (const r of rows) {
    try {
      const d = await client.errorSummary(r.n8n_execution_id);
      const message = d.message ?? 'Erreur sans message';
      await q('UPDATE executions SET error_node=$2, error_message=$3, error_category=$4 WHERE id=$1',
        [r.id, d.node, message, classifyError(message)]);
    } catch {
      await q(`UPDATE executions SET error_category='logic', error_message=COALESCE(error_message,'Détail indisponible') WHERE id=$1`, [r.id]);
    }
  }
}

/** Purge des exécutions au-delà de la durée de conservation de chaque instance. */
export async function purgeOldExecutions(): Promise<number> {
  const r = await q<{ n: number }>(`
    WITH d AS (DELETE FROM executions e USING instances i
               WHERE e.instance_id = i.id AND e.started_at < now() - (i.retention_days * interval '1 day') RETURNING 1)
    SELECT count(*)::int n FROM d`);
  return r[0]?.n ?? 0;
}

export async function checkHealth(instanceId: string) {
  const inst = await one<Instance>('SELECT * FROM instances WHERE id=$1', [instanceId]);
  if (!inst) throw new Error('Instance introuvable');
  const h = await clientFor(inst).health();
  const status = h.authOk ? 'ok' : h.reachable ? 'degraded' : 'down';
  await q('UPDATE instances SET health_status=$2, health_message=$3, health_checked_at=now() WHERE id=$1', [instanceId, status, h.message]);
  return { status, ...h };
}
