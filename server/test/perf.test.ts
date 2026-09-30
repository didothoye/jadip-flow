import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, pool, q } from '../src/db.js';
import { encrypt } from '../src/lib/crypto.js';

/** Performances : 100 000 exécutions (métadonnées), 4 clients, 20 workflows, 90 jours. */
const N = Number(process.env.PERF_ROWS ?? 100000);
let app: FastifyInstance;
let admin: Session;
let client: Session;
const timings: Record<string, number> = {};

async function timed(label: string, s: Session, url: string, maxMs: number) {
  await s.req('GET', url); // échauffement (plans en cache)
  const t0 = performance.now();
  const r = await s.req('GET', url);
  const ms = Math.round(performance.now() - t0);
  expect(r.statusCode, `${url} ${r.body.slice(0, 200)}`).toBe(200);
  timings[label] = ms;
  expect(ms, `${label} : ${ms} ms`).toBeLessThan(maxMs);
  return r.json();
}

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  const inst = await one<any>(`INSERT INTO instances(name, base_url, api_key_enc, sync_enabled) VALUES ('perf','http://127.0.0.1:9',$1,false) RETURNING id`, [encrypt('x'.repeat(12))]);
  const clients = [];
  for (let c = 0; c < 4; c++) clients.push(await one<any>(`INSERT INTO clients(code, name) VALUES ($1,$2) RETURNING id`, [`perf-${c}`, `Client ${c}`]));
  for (let w = 0; w < 20; w++) {
    await q(`INSERT INTO workflows(instance_id, n8n_id, name, active, client_id, client_assignment, minutes_saved_per_execution) VALUES ($1,$2,$3,true,$4,'manual',5)`,
      [inst.id, String(w), `Workflow ${w}`, clients[w % 4].id]);
  }
  const t0 = performance.now();
  await pool.query(`
    INSERT INTO executions(instance_id, workflow_id, client_id, n8n_execution_id, status, mode, started_at, stopped_at, duration_ms, error_node, error_message, error_category)
    SELECT $1, w.id, w.client_id, g::text,
      CASE WHEN g % 10 = 0 THEN 'error' ELSE 'success' END, 'trigger',
      now() - (g::float / $2 * interval '90 days'), now() - (g::float / $2 * interval '90 days') + interval '3 seconds', 3000,
      CASE WHEN g % 10 = 0 THEN 'HTTP Request' END, CASE WHEN g % 10 = 0 THEN 'connect ETIMEDOUT' END, CASE WHEN g % 10 = 0 THEN 'network' END
    FROM generate_series(1, $2) g JOIN LATERAL (SELECT id, client_id FROM workflows ORDER BY n8n_id::int OFFSET (g % 20) LIMIT 1) w ON true`, [inst.id, N]);
  await pool.query('ANALYZE');
  timings.insert_ms = Math.round(performance.now() - t0);
  await createUser('admin@perf.test', 'admin');
  await createUser('client@perf.test', 'client', clients[0].id);
  admin = new Session(app);
  await admin.login('admin@perf.test');
  client = new Session(app);
  await client.login('client@perf.test');
}, 300000);

afterAll(async () => {
  writeFileSync('/tmp/jadip-flow-perf.json', JSON.stringify({ rows: N, timings }, null, 2));
  console.log('Performances (ms) :', timings);
  await app.close();
});

describe(`Performances — ${N} exécutions`, () => {
  it('volume en base', async () => {
    expect((await one<any>('SELECT count(*)::int n FROM executions')).n).toBe(N);
  });
  it('liste paginée (première page, page profonde, filtres)', async () => {
    const p1 = await timed('executions_page1', admin, '/api/admin/executions?limit=50', 500);
    let cursor = p1.nextCursor;
    for (let i = 0; i < 50; i++) cursor = (await admin.req('GET', `/api/admin/executions?limit=200&cursor=${cursor}`)).json().nextCursor;
    await timed('executions_page_profonde', admin, `/api/admin/executions?limit=50&cursor=${cursor}`, 500);
    await timed('executions_filtre_echecs', admin, '/api/admin/executions?limit=50&status=failed', 500);
    const wf = await one<any>('SELECT id FROM workflows LIMIT 1');
    await timed('executions_par_workflow', admin, `/api/admin/executions?limit=50&workflow_id=${wf.id}`, 500);
  });
  it('tableaux de bord', async () => {
    await timed('vue_flotte', admin, '/api/admin/overview', 2000);
    await timed('liste_clients', admin, '/api/admin/clients', 2000);
    await timed('liste_workflows', admin, '/api/admin/workflows', 2000);
    await timed('erreurs', admin, '/api/admin/errors', 1000);
    await timed('portail_accueil', client, '/api/portal/home', 1500);
  });
});
