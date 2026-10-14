import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createUser, makeApp, resetDb, Session } from './helpers.js';
import { q } from '../src/db.js';
import { addJob, listJobs, runJobTracked } from '../src/scheduler.js';

/** Fiche 3 — chaque tâche planifiée laisse une trace dans le suivi, même sans valeur de retour ; un échec y figure avec son message. */
let app: FastifyInstance;
let admin: Session;

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  expect((await admin.login('admin@jadip.test')).statusCode).toBe(200);
});
afterAll(async () => { await app.close(); });

describe('Suivi des tâches planifiées', () => {
  it('consigne un passage pour chacune des tâches déclarées, « alerts » et « alert-notifications » comprises', async () => {
    const names = listJobs();
    expect(names).toEqual(expect.arrayContaining(['sync', 'alerts', 'alert-notifications', 'outbox', 'webhooks', 'resume-paused', 'purge']));
    for (const n of names) expect(await runJobTracked(n), n).toBe('ok');
    const rows = await q<any>('SELECT name, last_status, last_message FROM job_runs ORDER BY name');
    expect(rows.map((r) => r.name).sort()).toEqual([...names].sort());
    for (const r of rows) expect(r.last_status, r.name).toBe('ok');
    expect(rows.find((r) => r.name === 'alerts').last_message).toMatch(/"expired":0/);
    expect(rows.find((r) => r.name === 'alert-notifications').last_message).toMatch(/"notified":0/);
    const page = await admin.json('GET', '/api/admin/jobs');
    expect(page.jobs.map((j: any) => j.name)).toContain('alerts');
  });

  it('enregistre un échec de tâche avec son message', async () => {
    addJob({ name: 'test-echec', everyMs: 3600_000, lockKey: 9999, run: async () => { throw new Error('panne simulée'); } });
    expect(await runJobTracked('test-echec')).toBe('error');
    const r = (await q<any>(`SELECT * FROM job_runs WHERE name='test-echec'`))[0];
    expect(r.last_status).toBe('error');
    expect(r.last_message).toBe('panne simulée');
    expect(r.last_finished_at).toBeTruthy();
  });
});
