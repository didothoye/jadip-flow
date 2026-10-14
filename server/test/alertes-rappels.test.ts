import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeN8n, createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, q } from '../src/db.js';
import { evaluatePeriodic, flushAlertNotifications, raiseAlert, type Rule } from '../src/services/alerts.js';
import { saveSetting } from '../src/services/settings.js';
import { saveTelegramConfig } from '../src/services/telegram.js';
import { setWorkflowActive } from '../src/services/actions.js';
import { systemActor } from '../src/lib/actor.js';

/**
 * Fiche 1 — rappels bornés, expiration et résolution automatique des alertes d'échec,
 * import initial sans alerte sur l'historique.
 */
let app: FastifyInstance;
let fake: any;
let admin: Session;
let instanceId: string;

const telegram = () => q<any>(`SELECT * FROM outbox WHERE channel='telegram' ORDER BY id`);
const ruleFor = async (kind: string) => (await one<Rule>('SELECT * FROM alert_rules WHERE kind=$1 AND client_id IS NULL AND workflow_id IS NULL', [kind]))!;
const backdateNotification = (id: number, minutes: number) => q(`UPDATE alerts SET last_notified_at = now() - ($2 * interval '1 minute') WHERE id=$1`, [id, minutes]);

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  fake = createFakeN8n({ apiKey: 'test-key-123456', days: 10 });
  const port = await fake.listen();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  expect((await admin.login('admin@jadip.test')).statusCode).toBe(200);
  await saveTelegramConfig({ botToken: '123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234', chatId: '-1001234567890' });
  await saveSetting('quietHours', { enabled: false, start: '22:00', end: '07:00' });
  const inst = await admin.json('POST', '/api/admin/instances', { name: 'n8n principal', base_url: `http://127.0.0.1:${port}`, api_key: 'test-key-123456' }, 201);
  instanceId = inst.id;
});

afterAll(async () => { await app.close(); await fake.close(); });

describe('Import initial', () => {
  it('importe l’historique des échecs sans ouvrir d’alerte', async () => {
    expect(fake.state.executions.some((e: any) => e.status === 'error')).toBe(true);
    const s = await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    expect(s.status).toBe('success');
    expect(s.executionsImported).toBe(fake.state.executions.length);
    expect((await one<any>(`SELECT count(*)::int n FROM executions WHERE status='error'`)).n).toBeGreaterThan(0);
    expect(await one(`SELECT 1 FROM alerts WHERE kind='execution_failed'`)).toBeNull();
    expect((await telegram()).length).toBe(0);
  });

  it('alerte sur un échec survenu après le rattachement de l’instance', async () => {
    fake.addExecution('103', 'error', { node: 'OpenAI', message: '429 Too Many Requests' });
    await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    const a = await one<any>(`SELECT * FROM alerts WHERE kind='execution_failed'`);
    expect(a).toBeTruthy();
    expect(a.status).toBe('open');
    expect((await telegram()).length).toBe(1);
  });
});

describe('Rappels bornés', () => {
  let alertId: number;
  beforeAll(async () => {
    await q(`DELETE FROM outbox; DELETE FROM alerts; DELETE FROM notifications`);
    const rule = await ruleFor('execution_failed');
    expect(rule.max_reminders).toBe(3);
    alertId = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-rappels', title: 'Échec : Facturation', message: 'Nœud : HTTP', severity: 'critical', increment: 1 });
    expect((await telegram()).length).toBe(1);
    expect((await telegram())[0].bypass_quiet).toBe(true); // première notification critique : passe les horaires calmes
  });

  it('n’envoie rien avant le délai de répétition', async () => {
    await flushAlertNotifications();
    expect((await telegram()).length).toBe(1);
  });

  it('envoie au plus trois rappels, le dernier le dit, puis se tait', async () => {
    for (let i = 1; i <= 3; i++) {
      await backdateNotification(alertId, 241);
      const r = await flushAlertNotifications();
      expect(r.notified).toBe(1);
      const out = await telegram();
      expect(out.length).toBe(1 + i);
      expect(out[i].body).toContain(i === 3 ? 'Dernier rappel — Échec : Facturation' : 'Rappel — Échec : Facturation');
      expect(out[i].bypass_quiet).toBe(false); // un rappel respecte les horaires calmes
    }
    expect((await telegram())[3].body).toContain('plus aucun rappel ne sera envoyé');
    expect((await one<any>('SELECT reminders_sent FROM alerts WHERE id=$1', [alertId])).reminders_sent).toBe(3);
    await backdateNotification(alertId, 241);
    expect((await flushAlertNotifications()).notified).toBe(0);
    expect((await telegram()).length).toBe(4);
    expect((await one<any>('SELECT status FROM alerts WHERE id=$1', [alertId])).status).toBe('open'); // reste visible dans le portail
  });

  it('relance les rappels après une nouvelle rafale d’échecs', async () => {
    const rule = await ruleFor('execution_failed');
    // la fenêtre de regroupement est écoulée depuis longtemps : la rafale est notifiée aussitôt, et passe les horaires calmes
    await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-rappels', title: 'Échec : Facturation', message: 'Nœud : HTTP', severity: 'critical', increment: 2 });
    const out = await telegram();
    expect(out.length).toBe(5);
    expect(out[4].body).toMatch(/2 échecs en .* — Échec : Facturation/);
    expect(out[4].bypass_quiet).toBe(true);
    expect((await one<any>('SELECT reminders_sent FROM alerts WHERE id=$1', [alertId])).reminders_sent).toBe(0);
  });

  it('un rappel différé pendant les horaires calmes part à la fin de la plage', async () => {
    await saveSetting('quietHours', { enabled: true, start: '00:00', end: '23:59' });
    await backdateNotification(alertId, 241);
    await flushAlertNotifications();
    const out = await telegram();
    expect(out.length).toBe(6);
    expect(new Date(out[5].not_before).getTime()).toBeGreaterThan(Date.now() + 60_000);
    await saveSetting('quietHours', { enabled: false, start: '22:00', end: '07:00' });
  });

  it('le plafond est réglable par règle (0 = aucun rappel)', async () => {
    const rule = await ruleFor('execution_failed');
    await admin.json('PATCH', `/api/admin/alert-rules/${rule.id}`, { max_reminders: 0 });
    const id = await raiseAlert({ rule: { ...rule, max_reminders: 0 }, kind: 'execution_failed', dedupKey: 'execution_failed:wf-zero', title: 'Échec : Paie', message: 'x', severity: 'critical', increment: 1 });
    await backdateNotification(id, 241);
    expect((await flushAlertNotifications()).notified).toBe(0);
    await admin.json('PATCH', `/api/admin/alert-rules/${rule.id}`, { max_reminders: 3 });
    expect((await admin.json('GET', '/api/admin/alert-rules')).find((r: any) => r.id === rule.id).max_reminders).toBe(3);
  });
});

describe('Résolution automatique', () => {
  it('expire une alerte d’échec sans nouvelle occurrence depuis la fenêtre de la règle, avec audit', async () => {
    const rule = await ruleFor('execution_failed');
    const id = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-expire', title: 'Échec : Relances', message: 'x', severity: 'critical', increment: 1 });
    await q(`UPDATE alerts SET last_seen_at = now() - interval '25 hours' WHERE id=$1`, [id]);
    const r = await evaluatePeriodic();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const a = await one<any>('SELECT * FROM alerts WHERE id=$1', [id]);
    expect(a.status).toBe('resolved');
    expect(a.resolved_reason).toBe('expirée');
    expect(await one(`SELECT 1 FROM audit_log WHERE action='alert.auto_resolved' AND target_id=$1 AND detail->>'reason'='expirée'`, [String(id)])).toBeTruthy();
    // un nouvel échec rouvre une alerte neuve, notifiée immédiatement
    await q(`DELETE FROM outbox`);
    const id2 = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-expire', title: 'Échec : Relances', message: 'x', severity: 'critical', increment: 1 });
    expect(id2).not.toBe(id);
    expect((await telegram()).length).toBe(1);
  });

  it('ne touche pas à une alerte récente', async () => {
    const rule = await ruleFor('execution_failed');
    const id = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-recente', title: 'Échec : Devis', message: 'x', severity: 'critical', increment: 1 });
    await evaluatePeriodic();
    expect((await one<any>('SELECT status FROM alerts WHERE id=$1', [id])).status).toBe('open');
  });

  it('résout l’alerte d’un workflow désactivé depuis le portail', async () => {
    const rule = await ruleFor('execution_failed');
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='103'`);
    await raiseAlert({ rule, kind: 'execution_failed', dedupKey: `execution_failed:${wf.id}`, title: 'Échec : Avis', message: 'x', severity: 'critical', workflowId: wf.id, increment: 1 });
    expect(await one(`SELECT 1 FROM alerts WHERE workflow_id=$1 AND status='open'`, [wf.id])).toBeTruthy();
    await setWorkflowActive(systemActor, wf.id, false, { reason: 'test' });
    const a = await one<any>(`SELECT status, resolved_reason FROM alerts WHERE workflow_id=$1`, [wf.id]);
    expect(a).toEqual({ status: 'resolved', resolved_reason: 'workflow arrêté' });
  });

  it('résout l’alerte d’un workflow supprimé ou désactivé côté n8n à l’évaluation périodique', async () => {
    const rule = await ruleFor('execution_failed');
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='102'`);
    const id = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: `execution_failed:${wf.id}`, title: 'Échec : Factures', message: 'x', severity: 'critical', workflowId: wf.id, increment: 1 });
    await q(`UPDATE workflows SET deleted_at=now() WHERE id=$1`, [wf.id]);
    const r = await evaluatePeriodic();
    expect(r.stopped).toBeGreaterThanOrEqual(1);
    expect((await one<any>('SELECT resolved_reason FROM alerts WHERE id=$1', [id])).resolved_reason).toBe('workflow arrêté');
    await q(`UPDATE workflows SET deleted_at=NULL WHERE id=$1`, [wf.id]);
  });

  it('note « reprise » quand une exécution réussit, « manuelle » depuis le portail', async () => {
    const rule = await ruleFor('execution_failed');
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='101'`);
    const id = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: `execution_failed:${wf.id}`, title: 'Échec : Commandes', message: 'x', severity: 'critical', workflowId: wf.id, increment: 1 });
    fake.addExecution('101', 'success');
    await admin.json('POST', `/api/admin/instances/${instanceId}/sync`);
    await evaluatePeriodic();
    expect((await one<any>('SELECT resolved_reason FROM alerts WHERE id=$1', [id])).resolved_reason).toBe('reprise');
    const id2 = await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-manuelle', title: 'Échec : Paie', message: 'x', severity: 'critical', increment: 1 });
    await admin.json('POST', `/api/admin/alerts/${id2}/resolve`);
    expect((await one<any>('SELECT resolved_reason FROM alerts WHERE id=$1', [id2])).resolved_reason).toBe('manuelle');
    await admin.json('POST', `/api/admin/alerts/${id2}/reopen`);
    expect(await one<any>('SELECT resolved_reason, reminders_sent FROM alerts WHERE id=$1', [id2])).toEqual({ resolved_reason: null, reminders_sent: 0 });
  });
});
