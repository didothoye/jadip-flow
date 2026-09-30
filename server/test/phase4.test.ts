import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { createFakeN8n, createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, q } from '../src/db.js';
import { encrypt, hmacSha256 } from '../src/lib/crypto.js';
import { deliverWebhooks } from '../src/services/webhooks.js';

let app: FastifyInstance;
let fake: any;
let admin: Session;
let alice: Session;
let kivu: any;
let lumiere: any;
let adminRead = '';
let adminWrite = '';
let aliceTok = '';

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  fake = createFakeN8n({ apiKey: 'k-123456789' });
  const port = await fake.listen();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  await admin.login('admin@jadip.test');
  kivu = await admin.json('POST', '/api/admin/clients', { code: 'demo-kivu', name: 'Boulangerie Kivu (démo)' }, 201);
  lumiere = await admin.json('POST', '/api/admin/clients', { code: 'demo-lumiere', name: 'Cabinet Lumière (démo)' }, 201);
  const inst = await admin.json('POST', '/api/admin/instances', { name: 'n8n', base_url: `http://127.0.0.1:${port}`, api_key: 'k-123456789' }, 201);
  await admin.json('POST', `/api/admin/instances/${inst.id}/sync`);
  await createUser('alice@kivu.test', 'client', kivu.id);
  alice = new Session(app);
  await alice.login('alice@kivu.test');
  adminRead = (await admin.json('POST', '/api/tokens', { name: 'lecture', scopes: ['read'] }, 201)).token;
  adminWrite = (await admin.json('POST', '/api/tokens', { name: 'écriture', scopes: ['read', 'write'] }, 201)).token;
  aliceTok = (await alice.json('POST', '/api/tokens', { name: 'intégration Kivu', scopes: ['read', 'write'] }, 201)).token;
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('API REST v1', () => {
  it('jetons : stockés hachés, jamais réaffichés', async () => {
    expect(adminRead).toMatch(/^jf_/);
    const rows = await q<any>('SELECT token_hash FROM api_tokens');
    expect(rows.map((r) => r.token_hash)).not.toContain(adminRead);
    const list = await admin.json('GET', '/api/tokens');
    expect(JSON.stringify(list)).not.toContain(adminRead.slice(8));
  });

  it('lecture des clients, workflows, exécutions, erreurs, coûts', async () => {
    const clients = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(adminRead) });
    expect(clients.statusCode).toBe(200);
    expect(clients.json().length).toBe(3);
    const wfs = (await app.inject({ method: 'GET', url: `/api/v1/workflows?client_id=${kivu.id}`, headers: bearer(adminRead) })).json();
    expect(wfs).toHaveLength(3);
    const ex = (await app.inject({ method: 'GET', url: `/api/v1/executions?workflow_id=${wfs[0].id}&limit=10`, headers: bearer(adminRead) })).json();
    expect(ex.items).toHaveLength(10);
    expect(ex.nextCursor).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/v1/errors?category=rate_limit', headers: bearer(adminRead) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/costs', headers: bearer(adminRead) })).statusCode).toBe(200);
    const audit = await one<any>(`SELECT * FROM audit_log WHERE action='api.request' ORDER BY id DESC LIMIT 1`);
    expect(audit.source).toBe('api');
  });

  it('actions : portée « write » exigée', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='102'`);
    expect((await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/deactivate`, headers: bearer(adminRead) })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/deactivate`, headers: bearer(adminWrite) });
    expect(ok.statusCode).toBe(200);
    expect(fake.state.workflows.find((w: any) => w.id === '102').active).toBe(false);
    await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/activate`, headers: bearer(adminWrite) });
  });

  it('jeton client limité à son client', async () => {
    const cl = (await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(aliceTok) })).json();
    expect(cl.map((c: any) => c.id)).toEqual([kivu.id]);
    const other = await app.inject({ method: 'GET', url: `/api/v1/workflows?client_id=${lumiere.id}`, headers: bearer(aliceTok) });
    expect(other.statusCode).toBe(404);
    const wfB = await one<any>(`SELECT id FROM workflows WHERE n8n_id='201'`);
    expect((await app.inject({ method: 'GET', url: `/api/v1/workflows/${wfB.id}`, headers: bearer(aliceTok) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/workflows/${wfB.id}/deactivate`, headers: bearer(aliceTok) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/admin/clients', headers: bearer(aliceTok) })).statusCode).toBe(403);
    const ex = (await app.inject({ method: 'GET', url: '/api/v1/executions?limit=200', headers: bearer(aliceTok) })).json();
    expect(ex.items.every((e: any) => e.client_id === kivu.id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/costs', headers: bearer(aliceTok) })).statusCode).toBe(404); // coûts non autorisés
  });

  it('jeton révoqué refusé', async () => {
    const t = await admin.json('POST', '/api/tokens', { name: 'temp' }, 201);
    await admin.json('DELETE', `/api/tokens/${t.id}`);
    expect((await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(t.token) })).statusCode).toBe(401);
  });

  it('documentation OpenAPI', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(r.statusCode).toBe(200);
    const paths = Object.keys(r.json().paths);
    expect(paths).toContain('/api/v1/workflows/{id}/activate');
    expect(paths.some((p) => p.startsWith('/api/admin'))).toBe(false);
  });

  it('limitation de débit par jeton', async () => {
    const t = (await admin.json('POST', '/api/tokens', { name: 'rafale' }, 201)).token;
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const r = await app.inject({ method: 'GET', url: '/healthz', headers: bearer(t) });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('Serveur MCP', () => {
  const rpc = (tok: string, body: any) => app.inject({ method: 'POST', url: '/mcp', headers: { ...bearer(tok), accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: body });

  it('liste et appelle les outils ; journalise', async () => {
    const init = await rpc(adminRead, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('jadip-flow');
    const list = await rpc(adminRead, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fleet_overview', 'list_clients', 'list_workflows', 'recent_errors', 'get_workflow', 'llm_costs']));
    const call = await rpc(adminRead, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recent_errors', arguments: { limit: 5 } } });
    const data = JSON.parse(call.json().result.content[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('error_category');
    const log = await one<any>(`SELECT * FROM audit_log WHERE source='mcp' AND target_id='recent_errors'`);
    expect(log.actor_label).toBe('admin@jadip.test');
  });

  it('refuse sans jeton, et cloisonne un jeton client', async () => {
    const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { cookie: admin.cookie, 'x-jf-csrf': '1' } });
    expect(r.statusCode).toBe(401);
    const call = await rpc(aliceTok, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_clients', arguments: {} } });
    const data = JSON.parse(call.json().result.content[0].text);
    expect(data.map((c: any) => c.name)).toEqual(['Boulangerie Kivu (démo)']);
  });
});

describe('Webhooks sortants', () => {
  it('signe (HMAC) et livre les événements, avec nouvelles tentatives', async () => {
    const received: any[] = [];
    let fail = true;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (fail) { fail = false; res.writeHead(500); return res.end(); }
        received.push({ headers: req.headers, body });
        res.writeHead(200); res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    // création par l'API (https exigé), puis URL locale pour le test
    const h = await admin.json('POST', '/api/admin/webhooks', { name: 'Test', url: 'https://example.com/hook', events: ['workflow.deactivated_by_client', 'ticket.created'] }, 201);
    await q('UPDATE webhooks SET url=$2, secret_enc=$3 WHERE id=$1', [h.id, `http://127.0.0.1:${port}/hook`, encrypt(h.secret)]);
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='101'`);
    await alice.json('POST', `/api/portal/workflows/${wf.id}/deactivate`, {});
    await deliverWebhooks();
    expect(received).toHaveLength(0);
    await q(`UPDATE webhook_deliveries SET next_attempt_at=now()`);
    await deliverWebhooks();
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers['x-jadip-event']).toBe('workflow.deactivated_by_client');
    expect(headers['x-jadip-signature']).toBe(`sha256=${hmacSha256(h.secret, `${headers['x-jadip-timestamp']}.${body}`)}`);
    expect(JSON.parse(body).data.by).toBe('alice@kivu.test');
    srv.close();
  });
});
