import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, q } from '../src/db.js';
import { config } from '../src/config.js';
import { DEFAULT_RULES, flushAlertNotifications, raiseAlert, type Rule } from '../src/services/alerts.js';
import { notifyAdmins } from '../src/services/notify.js';
import { getTelegramConfig, invalidateTelegramCache, seedTelegramFromEnv } from '../src/services/telegram.js';
import { ALERT_TYPES } from '../src/services/alert-types.js';

const TOKEN = '123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234';
const CHAT = '-1001234567890';

let app: FastifyInstance;
let admin: Session;
const realFetch = globalThis.fetch;

/** Simule l'API Telegram : capture l'URL et le corps, renvoie la réponse voulue. */
function fakeTelegram(status: number, body: unknown) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

async function telegramOutbox() {
  return q<any>(`SELECT * FROM outbox WHERE channel='telegram' ORDER BY id`);
}

async function ruleFor(kind: string): Promise<Rule> {
  const r = await one<Rule>('SELECT * FROM alert_rules WHERE kind=$1 AND client_id IS NULL AND workflow_id IS NULL', [kind]);
  if (!r) throw new Error(`règle ${kind} absente`);
  return r;
}

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  expect((await admin.login('admin@jadip.test')).statusCode).toBe(200);
});

afterAll(async () => { await app.close(); });
afterEach(() => { vi.stubGlobal('fetch', realFetch); });

describe('Compte Telegram modifiable depuis les paramètres', () => {
  it('n’a rien de configuré au départ (ni .env en test, ni base)', async () => {
    const s = await admin.json('GET', '/api/admin/settings');
    expect(s.telegram).toEqual({ configured: false, tokenMasked: null, chatId: null, source: 'none' });
    expect(s.channels.telegram).toBe(false);
    const t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/Renseignez d’abord/);
  });

  it('refuse un jeton ou un identifiant mal formés', async () => {
    expect((await admin.req('PUT', '/api/admin/settings/telegram', { bot_token: 'pas-un-jeton', chat_id: CHAT })).statusCode).toBe(400);
    expect((await admin.req('PUT', '/api/admin/settings/telegram', { bot_token: TOKEN, chat_id: 'abc' })).statusCode).toBe(400);
  });

  it('enregistre le compte en base, chiffré, et ne réaffiche jamais le jeton en clair', async () => {
    const r = await admin.json('PUT', '/api/admin/settings/telegram', { bot_token: TOKEN, chat_id: CHAT });
    expect(r).toEqual({ configured: true, tokenMasked: '••••1234', chatId: CHAT, source: 'db' });
    const s = await admin.json('GET', '/api/admin/settings');
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(s.telegram.tokenMasked).toBe('••••1234');
    expect(s.channels.telegram).toBe(true);
    const row = await one<any>(`SELECT value FROM settings WHERE key='telegram_channel'`);
    expect(row.value.botTokenEnc).toMatch(/^v1:/);
    expect(JSON.stringify(row.value)).not.toContain(TOKEN);
    const auditRows = await q<any>(`SELECT detail FROM audit_log WHERE action='settings.telegram_updated'`);
    expect(auditRows.length).toBe(1);
    expect(JSON.stringify(auditRows)).not.toContain(TOKEN);
    expect(auditRows[0].detail.token_changed).toBe(true);
    expect((await getTelegramConfig()).botToken).toBe(TOKEN);
  });

  it('conserve le jeton quand seul l’identifiant change, et prend effet immédiatement', async () => {
    const r = await admin.json('PUT', '/api/admin/settings/telegram', { chat_id: '987654321' });
    expect(r.tokenMasked).toBe('••••1234');
    expect(r.chatId).toBe('987654321');
    expect(await getTelegramConfig()).toMatchObject({ botToken: TOKEN, chatId: '987654321', source: 'db' });
    await admin.json('PUT', '/api/admin/settings/telegram', { chat_id: CHAT });
  });

  it('envoie le message de test avec le compte enregistré et confirme la réception', async () => {
    const calls = fakeTelegram(200, { ok: true, result: { message_id: 1 } });
    const t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.ok).toBe(true);
    expect(t.message).toContain(CHAT);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0].body.chat_id).toBe(CHAT);
    expect(calls[0].body.text).toContain('message de test');
  });

  it('explique les erreurs renvoyées par Telegram sans divulguer le jeton', async () => {
    fakeTelegram(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    let t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/Jeton du bot invalide/);
    expect(t.message).not.toContain(TOKEN);

    fakeTelegram(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.message).toMatch(/Discussion introuvable/);

    fakeTelegram(403, { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.message).toMatch(/\/start/);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}`) }); }));
    t = await admin.json('POST', '/api/admin/settings/test-channel', { channel: 'telegram' });
    expect(t.message).toMatch(/Telegram injoignable/);
    expect(t.message).not.toContain(TOKEN);
  });

  it('reprend le .env comme valeurs initiales une seule fois, puis la base fait foi', async () => {
    await q(`DELETE FROM settings WHERE key='telegram_channel'`);
    invalidateTelegramCache();
    config.telegram.botToken = '111111111:AAHenvenvenvenvenvenvenvenvenvenvenvENV1';
    config.telegram.adminChatId = '42424242';
    try {
      expect(await getTelegramConfig()).toMatchObject({ source: 'env', chatId: '42424242' });
      expect(await seedTelegramFromEnv()).toBe(true);
      expect(await getTelegramConfig()).toMatchObject({ source: 'db', chatId: '42424242' });
      expect(await seedTelegramFromEnv()).toBe(false);
      await admin.json('PUT', '/api/admin/settings/telegram', { bot_token: TOKEN, chat_id: CHAT });
      config.telegram.adminChatId = '99999';
      invalidateTelegramCache();
      expect(await getTelegramConfig()).toMatchObject({ botToken: TOKEN, chatId: CHAT, source: 'db' });
    } finally {
      config.telegram.botToken = '';
      config.telegram.adminChatId = '';
      invalidateTelegramCache();
    }
  });
});

describe('Seules les alertes importantes partent sur Telegram', () => {
  it('ne propose plus d’alerte d’inactivité', async () => {
    expect(DEFAULT_RULES.map((r) => r.kind)).not.toContain('workflow_inactive');
    expect(await one(`SELECT 1 FROM alert_rules WHERE kind='workflow_inactive'`)).toBeNull();
    await expect(q(`INSERT INTO alert_rules(name, kind) VALUES ('x','workflow_inactive')`)).rejects.toThrow();
    expect((await admin.req('POST', '/api/admin/alert-rules', { name: 'x', kind: 'workflow_inactive' })).statusCode).toBe(400);
  });

  it('classe les types : critiques activés par défaut, informations désactivées', async () => {
    const s = await admin.json('GET', '/api/admin/settings');
    expect(s.alertTypes.map((t: any) => t.kind)).toEqual(ALERT_TYPES.map((t) => t.kind));
    for (const t of ALERT_TYPES) expect(s.telegramAlerts[t.kind]).toBe(t.level === 'critical');
    expect(s.telegramAlerts.execution_failed).toBe(true);
    expect(s.telegramAlerts.sync_failed).toBe(true);
    expect(s.telegramAlerts.failure_rate).toBe(false);
  });

  it('envoie un échec d’exécution sur Telegram à la discussion enregistrée', async () => {
    await q(`DELETE FROM outbox`);
    const rule = await ruleFor('execution_failed');
    await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-a', title: 'Échec : Facturation', message: 'Nœud : HTTP', severity: 'critical', increment: 1 });
    const out = await telegramOutbox();
    expect(out.length).toBe(1);
    expect(out[0].recipient).toBe(CHAT);
    expect(out[0].body).toContain('Échec : Facturation');
    expect(out[0].bypass_quiet).toBe(true);
  });

  it('regroupe une rafale d’échecs du même workflow en un seul message', async () => {
    const rule = await ruleFor('execution_failed');
    for (let i = 0; i < 4; i++) await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-a', title: 'Échec : Facturation', message: 'Nœud : HTTP', severity: 'critical', increment: 1 });
    expect((await telegramOutbox()).length).toBe(1); // rien de plus pendant la fenêtre de regroupement
    const a = await one<any>(`SELECT * FROM alerts WHERE dedup_key='execution_failed:wf-a'`);
    expect(a.occurrences).toBe(5);
    // la fenêtre de regroupement (15 min) est écoulée : un seul message récapitulatif
    await q(`UPDATE alerts SET last_notified_at = now() - interval '16 minutes' WHERE id=$1`, [a.id]);
    await flushAlertNotifications();
    const out = await telegramOutbox();
    expect(out.length).toBe(2);
    expect(out[1].body).toMatch(/4 échecs en 16 min/);
    await flushAlertNotifications();
    expect((await telegramOutbox()).length).toBe(2);
  });

  it('n’envoie pas sur Telegram un type désactivé, mais le garde dans le portail', async () => {
    await q(`DELETE FROM outbox; DELETE FROM notifications`);
    const rule = await ruleFor('failure_rate');
    await raiseAlert({ rule, kind: 'failure_rate', dedupKey: 'failure_rate:wf-b', title: 'Taux d’échec 40 % : Relances', message: '4 échecs sur 10', severity: 'warning', increment: 1 });
    expect((await telegramOutbox()).length).toBe(0);
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE '%Relances%'`)).toBeTruthy();
    expect(await one(`SELECT 1 FROM alerts WHERE dedup_key='failure_rate:wf-b' AND status='open'`)).toBeTruthy();
  });

  it('respecte les interrupteurs modifiés dans Paramètres', async () => {
    await q(`DELETE FROM outbox`);
    await admin.json('PATCH', '/api/admin/settings', { telegramAlerts: { execution_failed: false, ticket_created: true } });
    const s = await admin.json('GET', '/api/admin/settings');
    expect(s.telegramAlerts).toMatchObject({ execution_failed: false, ticket_created: true, sync_failed: true });
    const rule = await ruleFor('execution_failed');
    await raiseAlert({ rule, kind: 'execution_failed', dedupKey: 'execution_failed:wf-c', title: 'Échec : Paie', message: 'x', severity: 'critical', increment: 1 });
    expect((await telegramOutbox()).length).toBe(0);
    await notifyAdmins({ kind: 'ticket_created', title: 'Nouvelle demande — Kivu', body: 'Question n° 1', channels: ['app', 'telegram'] });
    await notifyAdmins({ kind: 'ticket_reply', title: 'Réponse client — demande n° 1', body: '…', channels: ['app', 'telegram'] });
    const out = await telegramOutbox();
    expect(out.length).toBe(1);
    expect(out[0].body).toContain('Nouvelle demande');
    await admin.json('PATCH', '/api/admin/settings', { telegramAlerts: { execution_failed: true, ticket_created: false } });
  });

  it('cesse tout envoi Telegram quand le compte est retiré', async () => {
    await q(`DELETE FROM outbox`);
    const r = await admin.json('PUT', '/api/admin/settings/telegram', { bot_token: '', chat_id: '' });
    expect(r.configured).toBe(false);
    expect(r.tokenMasked).toBeNull();
    const rule = await ruleFor('sync_failed');
    await raiseAlert({ rule, kind: 'sync_failed', dedupKey: 'sync_failed:inst-1', title: 'Synchronisation en panne : Prod', message: '2 échecs', severity: 'critical', increment: 1 });
    expect((await telegramOutbox()).length).toBe(0);
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE '%Synchronisation en panne%'`)).toBeTruthy();
  });
});
