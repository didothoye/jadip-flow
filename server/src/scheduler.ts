import { config } from './config.js';
import { q, withLock } from './db.js';
import { log } from './lib/log.js';
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

/**
 * Exécute une tâche sous verrou et consigne chaque passage dans job_runs (page Système), y compris sans valeur de retour.
 * Un échec est journalisé au niveau « error » (journal JSON, filtrable) et enregistré avec son message.
 */
async function runJob(j: Job): Promise<'ok' | 'error' | 'skipped'> {
  const started = new Date();
  try {
    const r = await withLock(j.lockKey, j.run);
    if (!r.acquired) return 'skipped'; // une autre instance tient le verrou : rien à consigner
    const summary = r.result === undefined || r.result === null ? null : typeof r.result === 'object' ? JSON.stringify(r.result).slice(0, 500) : String(r.result);
    await record(j.name, 'ok', summary, started);
    return 'ok';
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500);
    log.error({ job: j.name, err: e }, `Tâche planifiée « ${j.name} » en échec : ${message}`);
    await record(j.name, 'error', message, started).catch((err) => log.error({ job: j.name, err }, 'Impossible de consigner l’échec de la tâche'));
    return 'error';
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
/** Même parcours que le planificateur (verrou, consignation, journal) ; pour les tests et l'exploitation. */
export const runJobTracked = async (name: string) => {
  const j = jobs.find((x) => x.name === name);
  if (!j) throw new Error(`Tâche inconnue : ${name}`);
  return runJob(j);
};
