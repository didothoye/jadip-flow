import { config } from './config.js';
import { q, withLock } from './db.js';
import { systemActor } from './lib/actor.js';
import { syncInstance, purgeOldExecutions } from './services/sync.js';
import { evaluatePeriodic, flushAlertNotifications } from './services/alerts.js';
import { flushOutbox } from './services/notify.js';
import { deliverWebhooks } from './services/webhooks.js';
import { resumePausedWorkflows } from './services/actions.js';

export interface Job { name: string; everyMs: number; lockKey: number; run: () => Promise<unknown> }

const jobs: Job[] = [];
export const addJob = (j: Job) => jobs.push(j);

async function record(name: string, status: string, message: string | null, started: Date) {
  await q(`INSERT INTO job_runs(name, last_started_at, last_finished_at, last_status, last_message) VALUES ($1,$2,now(),$3,$4)
           ON CONFLICT (name) DO UPDATE SET last_started_at=$2, last_finished_at=now(), last_status=$3, last_message=$4`, [name, started, status, message]);
}

async function runJob(j: Job) {
  const started = new Date();
  try {
    const r = await withLock(j.lockKey, j.run);
    if (r !== undefined) await record(j.name, 'ok', typeof r === 'object' ? JSON.stringify(r).slice(0, 500) : String(r), started);
  } catch (e: any) {
    console.error(`[tâche ${j.name}]`, e);
    await record(j.name, 'error', String(e?.message ?? e).slice(0, 500), started).catch(() => {});
  }
}

/** Synchronise les instances dont l'intervalle est écoulé. */
async function syncDue() {
  const due = await q<{ id: string }>(`SELECT id FROM instances WHERE sync_enabled AND
    (last_sync_at IS NULL OR last_sync_at <= now() - (sync_interval_minutes * interval '1 minute') + interval '10 seconds')`);
  const results = [];
  for (const i of due) results.push((await syncInstance(i.id, 'schedule')).status);
  return { synced: results.length };
}

addJob({ name: 'sync', everyMs: 60_000, lockKey: 1001, run: syncDue });
addJob({ name: 'alerts', everyMs: 5 * 60_000, lockKey: 1002, run: evaluatePeriodic });
addJob({ name: 'alert-notifications', everyMs: 60_000, lockKey: 1003, run: flushAlertNotifications });
addJob({ name: 'outbox', everyMs: 30_000, lockKey: 1004, run: flushOutbox });
addJob({ name: 'webhooks', everyMs: 30_000, lockKey: 1005, run: deliverWebhooks });
addJob({ name: 'resume-paused', everyMs: 60_000, lockKey: 1006, run: () => resumePausedWorkflows(systemActor) });
addJob({ name: 'purge', everyMs: 6 * 3600_000, lockKey: 1007, run: async () => ({
  executions: await purgeOldExecutions(),
  sessions: (await q(`DELETE FROM sessions WHERE expires_at < now() RETURNING 1`)).length,
  outbox: (await q(`DELETE FROM outbox WHERE status <> 'pending' AND created_at < now() - interval '30 days' RETURNING 1`)).length,
  deliveries: (await q(`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - interval '30 days' RETURNING 1`)).length,
  notifications: (await q(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days' RETURNING 1`)).length,
}) });

const timers: NodeJS.Timeout[] = [];

export function startScheduler() {
  if (!config.schedulerEnabled) return;
  for (const j of jobs) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await runJob(j); } finally { busy = false; }
    };
    setTimeout(tick, 5000 + Math.random() * 5000);
    timers.push(setInterval(tick, j.everyMs));
  }
}

export function stopScheduler() {
  for (const t of timers) clearInterval(t);
}

export const listJobs = () => jobs.map((j) => j.name);
export const runJobByName = async (name: string) => {
  const j = jobs.find((x) => x.name === name);
  if (!j) throw new Error(`Tâche inconnue : ${name}`);
  return j.run();
};
