import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { createFakeN8n, createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, q } from '../src/db.js';
import { fetchAnthropic, fetchOpenAI, fetchOpenRouter } from '../src/services/llm/providers.js';
import { attribute, fetchAccount } from '../src/services/llm/costs.js';
import { evaluatePeriodic } from '../src/services/alerts.js';
import { dataPath } from '../src/lib/files.js';
import { currentPeriod } from '../src/lib/time.js';

let app: FastifyInstance;
let fake: any;
let admin: Session;
let kivu: any;

const mockFetch = (body: any) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  fake = createFakeN8n({ apiKey: 'k-123456789' });
  const port = await fake.listen();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  await admin.login('admin@jadip.test');
  kivu = await admin.json('POST', '/api/admin/clients', { code: 'demo-kivu', name: 'Boulangerie Kivu (démo)', monthly_fee_usd: 150, monthly_budget_usd: 10 }, 201);
  const inst = await admin.json('POST', '/api/admin/instances', { name: 'n8n', base_url: `http://127.0.0.1:${port}`, api_key: 'k-123456789' }, 201);
  await admin.json('POST', `/api/admin/instances/${inst.id}/sync`);
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('Connecteurs fournisseurs', () => {
  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-03T00:00:00Z');

  it('OpenAI : coûts par projet et ligne', async () => {
    const r = await fetchOpenAI({ apiKey: 'x', from, to, fetchImpl: mockFetch({ data: [{ start_time: 1756684800, results: [{ amount: { value: 1.25, currency: 'usd' }, line_item: 'gpt-4o-mini, input', project_id: 'proj_kivu' }] }], has_more: false }) });
    expect(r).toEqual([expect.objectContaining({ day: '2025-09-01', model: 'gpt-4o-mini', project: 'proj_kivu', costUsd: 1.25 })]);
  });

  it('Anthropic : montants en cents convertis en dollars', async () => {
    const r = await fetchAnthropic({ apiKey: 'x', from, to, fetchImpl: mockFetch({ data: [{ starting_at: '2026-09-01T00:00:00Z', results: [{ amount: '250.5', currency: 'USD', workspace_id: 'wrkspc_1', description: 'Claude Haiku 4.5 Usage - Input Tokens', model: 'claude-haiku-4-5', token_type: 'uncached_input_tokens' }] }], has_more: false }) });
    expect(r[0].costUsd).toBeCloseTo(2.505);
    expect(r[0].workspace).toBe('wrkspc_1');
    expect(r[0].model).toBe('claude-haiku-4-5');
  });

  it('OpenRouter : delta quotidien de l’usage cumulé par clé', async () => {
    const r = await fetchOpenRouter({ apiKey: 'x', from, to, previousSnapshots: new Map([['kivu', 3]]), fetchImpl: mockFetch({ data: [{ hash: 'h1', label: 'kivu', usage: 4.5 }, { hash: 'h2', label: 'autre', usage: 1 }] }) });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].costUsd).toBeCloseTo(1.5);
    expect(r.snapshots.get('autre')).toBe(1);
  });

  it('attribution : clé API prioritaire sur le projet', () => {
    const rules = [
      { dimension: 'project', match_value: 'p1', client_id: 'A', workflow_id: null },
      { dimension: 'api_key', match_value: 'k1', client_id: 'B', workflow_id: 'W' },
    ];
    expect(attribute({ day: '', model: 'm', project: 'p1', apiKeyRef: 'k1', costUsd: 1, externalKey: '' }, rules)).toEqual({ clientId: 'B', workflowId: 'W' });
    expect(attribute({ day: '', model: 'm', project: 'p1', costUsd: 1, externalKey: '' }, rules).clientId).toBe('A');
    expect(attribute({ day: '', model: 'm', costUsd: 1, externalKey: '' }, rules).clientId).toBeNull();
  });
});

describe('Phase 2 — coûts, budget, rapports', () => {
  it('import, attribution par règle et réattribution rétroactive', async () => {
    const acc = await admin.json('POST', '/api/admin/llm/accounts', { provider: 'openai', name: 'OpenAI Jadip', api_key: 'sk-admin-test-000001' }, 201);
    const today = new Date().toISOString().slice(0, 10);
    const ts = Math.floor(new Date(`${today}T00:00:00Z`).getTime() / 1000);
    const body = { data: [{ start_time: ts, results: [
      { amount: { value: 12 }, line_item: 'gpt-4o, output', project_id: 'proj_kivu' },
      { amount: { value: 3 }, line_item: 'gpt-4o-mini, input', project_id: 'proj_interne' },
    ] }], has_more: false };
    const r1 = await fetchAccount(acc.id, 2, mockFetch(body));
    expect(r1.imported).toBe(2);
    await fetchAccount(acc.id, 2, mockFetch(body)); // pas de doublon
    expect((await one<any>('SELECT count(*)::int n FROM llm_usage')).n).toBe(2);
    const rule = await admin.json('POST', '/api/admin/llm/rules', { account_id: acc.id, dimension: 'project', match_value: 'proj_kivu', client_id: kivu.id }, 201);
    expect(rule.reattributed).toBe(1);
    const costs = await admin.json('GET', '/api/admin/costs');
    expect(costs.total.cost_usd).toBeCloseTo(15);
    expect(costs.total.unattributed).toBeCloseTo(3);
    expect(costs.byClient.find((c: any) => c.client_id === kivu.id).cost_usd).toBeCloseTo(12);
    const accounts = await admin.json('GET', '/api/admin/llm/accounts');
    expect(JSON.stringify(accounts)).not.toContain('sk-admin-test-000001');
  });

  it('saisie manuelle et estimation par exécution', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='103'`);
    await admin.json('PATCH', `/api/admin/workflows/${wf.id}`, { cost_per_execution_usd: 0.01 });
    await admin.json('POST', '/api/admin/llm/manual', { day: new Date().toISOString().slice(0, 10), provider: 'mistral', model: 'mistral-small', cost_usd: 2, client_id: kivu.id }, 201);
    const costs = await admin.json('GET', `/api/admin/costs?client_id=${kivu.id}`);
    const est = costs.byModel.find((m: any) => m.provider === 'estimation');
    expect(est.cost_usd).toBeGreaterThan(0);
    expect(costs.byModel.find((m: any) => m.provider === 'mistral').cost_usd).toBeCloseTo(2);
  });

  it('alerte de budget IA dépassé', async () => {
    await evaluatePeriodic();
    const a = await one<any>(`SELECT * FROM alerts WHERE kind='llm_budget' AND client_id=$1`, [kivu.id]);
    expect(a).toBeTruthy();
    expect(a.severity).toBe('critical');
  });

  it('rapport mensuel PDF et Excel (Times New Roman 12, en-tête Jadip Services)', async () => {
    const period = currentPeriod();
    const r = await admin.json('POST', '/api/admin/reports', { client_id: kivu.id, period }, 201);
    expect(r.summary.totals.executions).toBeGreaterThan(0);
    const row = await one<any>('SELECT * FROM reports WHERE id=$1', [r.id]);
    const pdf = readFileSync(dataPath(row.pdf_path));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Times-Roman');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(dataPath(row.xlsx_path));
    const ws = wb.getWorksheet('Synthèse')!;
    expect(ws.getCell('A1').value).toBe('Jadip Services');
    expect(ws.getCell('A6').font.name).toBe('Times New Roman');
    expect(ws.getCell('A6').font.size).toBe(12);
    expect(ws.getCell('A6').border.top?.style).toBe('thin');
    const dl = await admin.req('GET', `/api/admin/reports/${r.id}/pdf`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    // envoi : destinataire requis
    const send = await admin.req('POST', `/api/admin/reports/${r.id}/send`, {});
    expect(send.statusCode).toBe(400);
    await admin.json('PATCH', `/api/admin/clients/${kivu.id}`, { report_emails: ['compta@kivu.test'] });
    expect((await admin.json('POST', `/api/admin/reports/${r.id}/send`, {})).sent).toBe(1);
    const mail = await one<any>(`SELECT * FROM outbox WHERE recipient='compta@kivu.test'`);
    expect(mail.attachments).toHaveLength(2);
  });

  it('tableau de rentabilité', async () => {
    const p = await admin.json('GET', '/api/admin/profitability');
    const k = p.rows.find((r: any) => r.id === kivu.id);
    expect(k.fee).toBe(150);
    expect(k.margin).toBeCloseTo(150 - k.llm_cost);
  });
});
