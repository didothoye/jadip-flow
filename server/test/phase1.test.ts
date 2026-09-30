import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeN8n, createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, pool, q } from '../src/db.js';
import { verifyAuditChain } from '../src/audit.js';
import { classifyError } from '../src/services/classify.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { evaluatePeriodic } from '../src/services/alerts.js';

let app: FastifyInstance;
let fake: any;
let admin: Session;
let instanceId: string;
let kivu: any;

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  fake = createFakeN8n({ apiKey: 'test-key-123456' });
  const port = await fake.listen();
  (globalThis as any).fakeUrl = `http://127.0.0.1:${port}`;
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  const r = await admin.login('admin@jadip.test');
  expect(r.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('Fondations', () => {
  it('chiffre et déchiffre les secrets', () => {
    const e = encrypt('ma-cle-secrete');
    expect(e).not.toContain('ma-cle-secrete');
    expect(decrypt(e)).toBe('ma-cle-secrete');
  });

  it('classe les erreurs', () => {
    expect(classifyError('Request failed with status code 429')).toBe('rate_limit');
    expect(classifyError('invalid_grant: Token has been expired')).toBe('auth');
    expect(classifyError('connect ETIMEDOUT 1.2.3.4:443')).toBe('network');
    expect(classifyError("Cannot read properties of undefined (reading 'x')")).toBe('data');
    expect(classifyError('Aucune règle ne correspond')).toBe('logic');
  });

  it('refuse les requêtes non authentifiées et sans en-tête anti-CSRF', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/instances' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/admin/clients', headers: { cookie: admin.cookie }, payload: {} });
    expect(r.statusCode).toBe(403);
  });
});

describe('Phase 1 — instances et synchronisation', () => {
  it('crée les clients puis enregistre une instance sans jamais renvoyer la clé', async () => {
    kivu = await admin.json('POST', '/api/admin/clients', { code: 'demo-kivu', name: 'Boulangerie Kivu (démo)' }, 201);
    await admin.json('POST', '/api/admin/clients', { code: 'demo-lumiere', name: 'Cabinet Lumière (démo)' }, 201);
    const test = await admin.json('POST', '/api/admin/instances/test', { base_url: (globalThis as any).fakeUrl, api_key: 'test-key-123456' });
    expect(test.authOk).toBe(true);
    const bad = await admin.json('POST', '/api/admin/instances/test', { base_url: (globalThis as any).fakeUrl, api_key: 'mauvaise-cle-xx' });
    expect(bad.authOk).toBe(false);
    const inst = await admin.json('POST', '/api/admin/instances', { name: 'n8n principal', base_url: (globalThis as any).fakeUrl, api_key: 'test-key-123456' }, 201);
    instanceId = inst.id;
    expect(JSON.stringify(inst)).not.toContain('test-key-123456');
    expect(inst.api_key_hint).toBe('••••3456');
    const list = await admin.json('GET', '/api/admin/instances');
    expect(JSON.stringify(list)).not.toContain('test-key-123456');
    const row = await one<any>('SELECT api_key_enc FROM instances WHERE id=$1', [instanceId]);
    expect(row.api_key_enc).not.toContain('test-key-123456');
  });

  it('synchronise workflows et exécutions (métadonnées seulement)', async () => {
    const s = await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    expect(s.status).toBe('success');
    expect(s.workflowsSeen).toBe(9);
    expect(s.created).toBe(9);
    expect(s.executionsImported).toBe(fake.state.executions.length);
    const wfs = await q<any>('SELECT w.name, c.code FROM workflows w LEFT JOIN clients c ON c.id=w.client_id');
    expect(wfs.filter((w) => w.code === 'demo-kivu')).toHaveLength(3);
    expect(wfs.filter((w) => w.code === 'interne')).toHaveLength(2);
    expect(wfs.filter((w) => w.code === null)).toHaveLength(1);
    // erreurs : nœud fautif et catégorie
    const err = await one<any>(`SELECT * FROM executions WHERE status='error' AND error_message IS NOT NULL LIMIT 1`);
    expect(err.error_node).toBeTruthy();
    expect(err.error_category).toBeTruthy();
    // aucune donnée traitée ni configuration de nœud n'est stockée
    const dump = await q<any>(`SELECT row_to_json(e)::text t FROM executions e UNION ALL SELECT row_to_json(w)::text FROM workflows w`);
    const all = dump.map((d) => d.t).join('\n');
    expect(all).not.toContain('Données personnelles');
    expect(all).not.toContain('NE-DOIT-PAS-ETRE-STOCKE');
    expect(all).not.toContain('+243 000');
    const runs = await admin.json('GET', '/api/admin/sync-runs');
    expect(runs[0].status).toBe('success');
  });

  it('synchronisation incrémentale sans doublon, détecte renommage et suppression', async () => {
    fake.state.workflows.find((w: any) => w.id === '102').name = 'Kivu — Relance des factures (v2)';
    fake.state.workflows.find((w: any) => w.id === '401')._deleted = true;
    fake.addExecution('101', 'success');
    fake.addExecution('103', 'error', { node: 'OpenAI', message: '429 Too Many Requests' });
    const s = await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    expect(s.status).toBe('success');
    expect(s.renamed).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.executionsImported).toBe(2);
    const total = await one<any>('SELECT count(*)::int n FROM executions');
    expect(total.n).toBe(fake.state.executions.length);
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Workflows modifiés%'`)).toBeTruthy();
    const ev = await q<any>(`SELECT kind FROM workflow_events WHERE kind IN ('renamed','deleted')`);
    expect(ev.map((e) => e.kind).sort()).toEqual(['deleted', 'renamed']);
    const alert = await one<any>(`SELECT * FROM alerts WHERE kind='execution_failed' ORDER BY id DESC LIMIT 1`);
    expect(alert).toBeTruthy();
  });

  it('journalise un échec de synchronisation et alerte', async () => {
    await admin.json('PATCH', `/api/admin/instances/${instanceId}`, { api_key: 'cle-invalide-000' });
    for (let i = 0; i < 2; i++) {
      const s = await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
      expect(s.status).toBe('error');
    }
    const inst = await admin.json('GET', `/api/admin/instances/${instanceId}`);
    expect(inst.health_status).toBe('degraded');
    const a = await one<any>(`SELECT * FROM alerts WHERE kind='sync_failed' AND status='open'`);
    expect(a).toBeTruthy();
    await admin.json('PATCH', `/api/admin/instances/${instanceId}`, { api_key: 'test-key-123456' });
    expect((await admin.json('POST', `/api/admin/instances/${instanceId}/sync`)).status).toBe('success');
    expect(await one(`SELECT 1 FROM alerts WHERE kind='sync_failed' AND status='open'`)).toBeNull();
  });
});

describe('Phase 1 — tableau de bord et actions', () => {
  it('vue flotte et fiche client', async () => {
    const o = await admin.json('GET', '/api/admin/overview');
    expect(o.overview.instances).toBe(1);
    expect(o.overview.workflows_active).toBeGreaterThan(0);
    expect(o.series).toHaveLength(14);
    const c = await admin.json('GET', `/api/admin/clients/${kivu.id}`);
    expect(c.workflows).toHaveLength(3);
    expect(c.summary.exec_30d).toBeGreaterThan(0);
  });

  it('fiche workflow, pagination des exécutions', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='101'`);
    const d = await admin.json('GET', `/api/admin/workflows/${wf.id}`);
    expect(d.n8n_url).toContain('/workflow/101');
    const p1 = await admin.json('GET', `/api/admin/executions?workflow_id=${wf.id}&limit=50`);
    expect(p1.items).toHaveLength(50);
    const p2 = await admin.json('GET', `/api/admin/executions?workflow_id=${wf.id}&limit=50&cursor=${p1.nextCursor}`);
    expect(p2.items[0].id).not.toBe(p1.items[49].id);
    expect(new Date(p2.items[0].started_at) <= new Date(p1.items[49].started_at)).toBe(true);
  });

  it('active / désactive via n8n, avec verrou critique et journal', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='302'`);
    await admin.json('POST', `/api/admin/workflows/${wf.id}/deactivate`, { reason: 'test' });
    expect(fake.state.workflows.find((w: any) => w.id === '302').active).toBe(false);
    await admin.json('POST', `/api/admin/workflows/${wf.id}/activate`);
    expect(fake.state.workflows.find((w: any) => w.id === '302').active).toBe(true);
    await admin.json('PATCH', `/api/admin/workflows/${wf.id}`, { is_locked: true, description: 'Sauvegarde quotidienne', minutes_saved_per_execution: 10 });
    const r = await admin.req('POST', `/api/admin/workflows/${wf.id}/deactivate`, {});
    expect(r.statusCode).toBe(403);
    expect(fake.state.workflows.find((w: any) => w.id === '302').active).toBe(true);
    const log = await q<any>(`SELECT action, result FROM action_log WHERE workflow_id=$1 ORDER BY id`, [wf.id]);
    expect(log.map((l) => `${l.action}:${l.result}`)).toEqual(['deactivate:ok', 'activate:ok', 'deactivate:refused']);
  });

  it('relance une exécution en échec et marque une erreur comme traitée', async () => {
    const e = await one<any>(`SELECT id FROM executions WHERE status='error' ORDER BY id DESC LIMIT 1`);
    const r = await admin.json('POST', `/api/admin/executions/${e.id}/retry`);
    expect(r.retried).toBe(true);
    const h = await admin.json('POST', '/api/admin/executions/handled', { ids: [e.id] });
    expect(h.updated).toBe(1);
    const errs = await admin.json('GET', '/api/admin/errors?unhandled=true');
    expect(errs.items.find((x: any) => x.id === e.id)).toBeUndefined();
    expect(errs.categories.length).toBeGreaterThan(0);
  });

  it('rattachement manuel d’un workflow à un client', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='203'`);
    const other = await one<any>(`SELECT id FROM clients WHERE code='demo-kivu'`);
    const r = await admin.json('PATCH', `/api/admin/workflows/${wf.id}`, { client_id: other.id });
    expect(r.client_assignment).toBe('manual');
    await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    const after = await one<any>('SELECT client_id FROM workflows WHERE id=$1', [wf.id]);
    expect(after.client_id).toBe(other.id); // le rattachement manuel prime sur l'étiquette
    const back = await admin.json('PATCH', `/api/admin/workflows/${wf.id}`, { assignment: 'tag' });
    expect(back.client_assignment).toBe('tag');
    expect(back.client_name).toBe('Cabinet Lumière (démo)'); // réappliqué immédiatement
  });

  it('paramètres : un booléen enregistré peut être désactivé', async () => {
    await admin.json('PATCH', '/api/admin/settings', { notifyAdminOnClientAction: false });
    expect((await admin.json('GET', '/api/admin/settings')).notifyAdminOnClientAction).toBe(false);
    await admin.json('PATCH', '/api/admin/settings', { notifyAdminOnClientAction: true });
  });

  it('pagination des erreurs sans chevauchement', async () => {
    const p1 = await admin.json('GET', '/api/admin/errors?limit=5');
    const p2 = await admin.json('GET', `/api/admin/errors?limit=5&before=${p1.items[4].id}`);
    const ids1 = new Set(p1.items.map((e: any) => e.id));
    expect(p2.items.some((e: any) => ids1.has(e.id))).toBe(false);
    expect(new Date(p2.items[0].started_at) <= new Date(p1.items[4].started_at)).toBe(true);
  });

  it('évalue les alertes périodiques (inactivité, taux d’échec)', async () => {
    await evaluatePeriodic();
    const kinds = await q<any>(`SELECT DISTINCT kind FROM alerts`);
    expect(kinds.map((k) => k.kind)).toContain('execution_failed');
  });
});

describe('Journal d’audit', () => {
  it('est chaîné et inaltérable', async () => {
    const v = await verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(5);
    await expect(pool.query(`UPDATE audit_log SET action='x' WHERE id=1`)).rejects.toThrow(/inaltérable/);
    await expect(pool.query(`DELETE FROM audit_log WHERE id=1`)).rejects.toThrow(/inaltérable/);
  });
});
