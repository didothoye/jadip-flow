import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeN8n, createUser, makeApp, resetDb, Session } from './helpers.js';
import { one, q } from '../src/db.js';
import { routeTable } from '../src/app.js';
import { currentPeriod } from '../src/lib/time.js';

let app: FastifyInstance;
let fake: any;
let admin: Session;
let alice: Session; // cliente Kivu (A)
let bob: Session;   // client Lumière (B)
let kivu: any;
let lumiere: any;
let wfA: any;
let wfB: any;

function multipart(fields: Record<string, string>, files: { name: string; filename: string; type: string; content: string }[] = []) {
  const boundary = '----jadipflowtest';
  let body = '';
  for (const [k, v] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  for (const f of files) body += `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n${f.content}\r\n`;
  body += `--${boundary}--\r\n`;
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function postForm(s: Session, url: string, fields: Record<string, string>, files: any[] = []) {
  const m = multipart(fields, files);
  return app.inject({ method: 'POST', url, payload: m.body, headers: { ...m.headers, cookie: s.cookie, 'x-jf-csrf': '1' } });
}

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  fake = createFakeN8n({ apiKey: 'k-123456789' });
  const port = await fake.listen();
  await createUser('admin@jadip.test', 'admin');
  admin = new Session(app);
  await admin.login('admin@jadip.test');
  kivu = await admin.json('POST', '/api/admin/clients', { code: 'demo-kivu', name: 'Boulangerie Kivu (démo)', show_costs: true, can_retry: true }, 201);
  lumiere = await admin.json('POST', '/api/admin/clients', { code: 'demo-lumiere', name: 'Cabinet Lumière (démo)', show_costs: false }, 201);
  const inst = await admin.json('POST', '/api/admin/instances', { name: 'n8n', base_url: `http://127.0.0.1:${port}`, api_key: 'k-123456789' }, 201);
  await admin.json('POST', `/api/admin/instances/${inst.id}/sync`);
  await createUser('alice@kivu.test', 'client', kivu.id);
  await createUser('bob@lumiere.test', 'client', lumiere.id);
  alice = new Session(app);
  await alice.login('alice@kivu.test');
  bob = new Session(app);
  await bob.login('bob@lumiere.test');
  wfA = await one<any>(`SELECT id FROM workflows WHERE n8n_id='101'`);
  wfB = await one<any>(`SELECT id FROM workflows WHERE n8n_id='201'`);
  await admin.json('POST', '/api/admin/reports', { client_id: lumiere.id, period: currentPeriod() }, 201);
});

afterAll(async () => {
  await app.close();
  await fake.close();
});

describe('Invitation et activation', () => {
  it('invite un utilisateur client, active le compte avec un mot de passe robuste', async () => {
    const u = await admin.json('POST', `/api/admin/clients/${kivu.id}/users`, { email: 'carine@kivu.test', name: 'Carine' }, 201);
    const token = u.invite_link.split('/activer/')[1];
    const mail = await one<any>(`SELECT * FROM outbox WHERE recipient='carine@kivu.test'`);
    expect(mail.body).toContain('/activer/');
    expect((await app.inject({ method: 'GET', url: `/api/auth/invite/${token}` })).json().email).toBe('carine@kivu.test');
    const weak = await app.inject({ method: 'POST', url: '/api/auth/activate', payload: { token, password: 'court' } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/activate', payload: { token, password: 'UnBonMotDePasse2026' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.client_id).toBe(kivu.id);
    const again = await app.inject({ method: 'POST', url: '/api/auth/activate', payload: { token, password: 'UnBonMotDePasse2026' } });
    expect(again.statusCode).toBe(410);
  });

  it('double authentification optionnelle', async () => {
    const { authenticator } = await import('otplib');
    const setup = await alice.json('POST', '/api/me/totp/setup', {});
    expect(setup.qr).toMatch(/^data:image\/png/);
    await alice.json('POST', '/api/me/totp/enable', { code: authenticator.generate(setup.secret) });
    const s = new Session(app);
    const r = await s.login('alice@kivu.test');
    expect(r.json().mfaRequired).toBe(true);
    expect((await s.req('GET', '/api/portal/home')).statusCode).toBe(401);
    const bad = await s.req('POST', '/api/auth/mfa', { code: '000000' });
    expect(bad.statusCode).toBe(401);
    const good = await s.req('POST', '/api/auth/mfa', { code: authenticator.generate(setup.secret) });
    expect(good.statusCode).toBe(200);
    expect((await s.req('GET', '/api/portal/home')).statusCode).toBe(200);
  });
});

describe('Portail client', () => {
  it('accueil « Vos automatisations » : uniquement ses workflows, sans détail technique', async () => {
    const h = await alice.json('GET', '/api/portal/home');
    expect(h.client.name).toBe('Boulangerie Kivu (démo)');
    expect(h.workflows).toHaveLength(3);
    const txt = JSON.stringify(h);
    expect(txt).not.toContain('client:demo-kivu'); // pas d'étiquettes
    expect(txt).not.toContain('127.0.0.1'); // pas d'URL d'instance
    expect(txt).not.toContain('Lumière');
    expect(h.workflows[0]).not.toHaveProperty('n8n_id');
  });

  it('fiche workflow : erreurs expliquées en français simple, sans message technique', async () => {
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='103'`);
    const d = await alice.json('GET', `/api/portal/workflows/${wf.id}`);
    const errs = [...d.executions];
    let cursor = d.next_cursor;
    while (!errs.some((e: any) => e.explanation) && cursor) {
      const p = await alice.json('GET', `/api/portal/workflows/${wf.id}/executions?cursor=${cursor}`);
      errs.push(...p.items); cursor = p.next_cursor;
    }
    const e = errs.find((x: any) => x.explanation);
    expect(e.explanation).toMatch(/[a-z]/);
    expect(JSON.stringify(d)).not.toMatch(/ETIMEDOUT|invalid_grant|Cannot read/);
  });

  it('désactive, met en pause, réactive ; journalise et notifie l’agence', async () => {
    await alice.json('POST', `/api/portal/workflows/${wfA.id}/deactivate`, {});
    expect(fake.state.workflows.find((w: any) => w.id === '101').active).toBe(false);
    await alice.json('POST', `/api/portal/workflows/${wfA.id}/pause`, { hours: 2 });
    const w = await one<any>('SELECT paused_until FROM workflows WHERE id=$1', [wfA.id]);
    expect(new Date(w.paused_until).getTime()).toBeGreaterThan(Date.now() + 3600000);
    await alice.json('POST', `/api/portal/workflows/${wfA.id}/activate`, {});
    expect(fake.state.workflows.find((x: any) => x.id === '101').active).toBe(true);
    const log = await q<any>(`SELECT action FROM action_log WHERE workflow_id=$1 AND actor_role='client' ORDER BY id`, [wfA.id]);
    expect(log.map((l) => l.action)).toEqual(['deactivate', 'pause', 'activate']);
    const n = await one<any>(`SELECT * FROM notifications WHERE user_id IS NULL AND title LIKE 'Action client%' LIMIT 1`);
    expect(n).toBeTruthy();
    const audit = await one<any>(`SELECT * FROM audit_log WHERE action='workflow.pause'`);
    expect(audit.actor_label).toBe('alice@kivu.test');
  });

  it('refuse la désactivation d’un workflow verrouillé ou non autorisé', async () => {
    await admin.json('PATCH', `/api/admin/workflows/${wfA.id}`, { is_locked: true });
    expect((await alice.req('POST', `/api/portal/workflows/${wfA.id}/deactivate`, {})).statusCode).toBe(403);
    await admin.json('PATCH', `/api/admin/workflows/${wfA.id}`, { is_locked: false, client_can_toggle: false });
    expect((await alice.req('POST', `/api/portal/workflows/${wfA.id}/deactivate`, {})).statusCode).toBe(403);
    await admin.json('PATCH', `/api/admin/workflows/${wfA.id}`, { client_can_toggle: true });
    expect(fake.state.workflows.find((x: any) => x.id === '101').active).toBe(true);
  });

  it('relance une exécution en échec si autorisé', async () => {
    const e = await one<any>(`SELECT id FROM executions WHERE client_id=$1 AND status='error' LIMIT 1`, [kivu.id]);
    expect((await alice.json('POST', `/api/portal/executions/${e.id}/retry`, {})).retried).toBe(true);
    const eb = await one<any>(`SELECT id FROM executions WHERE client_id=$1 AND status='error' LIMIT 1`, [lumiere.id]);
    expect((await bob.req('POST', `/api/portal/executions/${eb.id}/retry`, {})).statusCode).toBe(403); // can_retry = false
  });

  it('coûts affichés seulement si autorisé', async () => {
    expect((await alice.req('GET', '/api/portal/costs')).statusCode).toBe(200);
    expect((await bob.req('GET', '/api/portal/costs')).statusCode).toBe(403);
  });

  it('demande avec pièce jointe, notifiée sur Telegram/app, suivi des statuts', async () => {
    const r = await postForm(alice, '/api/portal/tickets', { kind: 'change', subject: 'Ajouter le champ quantité', body: 'Pouvez-vous ajouter la quantité dans le tableau ?', workflow_id: wfA.id },
      [{ name: 'file', filename: 'capture.png', type: 'image/png', content: 'PNGDATA' }]);
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const bad = await postForm(alice, '/api/portal/tickets', { kind: 'problem', subject: 'x', body: 'y' }, [{ name: 'file', filename: 'x.exe', type: 'application/x-msdownload', content: 'MZ' }]);
    expect(bad.statusCode).toBe(400);
    const t = await alice.json('GET', `/api/portal/tickets/${id}`);
    expect(t.messages[0].attachments).toHaveLength(1);
    const att = await alice.req('GET', `/api/portal/attachments/${t.messages[0].attachments[0].id}`);
    expect(att.statusCode).toBe(200);
    expect(att.body).toBe('PNGDATA');
    expect(await one(`SELECT 1 FROM notifications WHERE title LIKE 'Nouvelle demande%'`)).toBeTruthy();
    const reply = await postForm(admin, `/api/admin/tickets/${id}/messages`, { body: 'C’est fait.', status: 'done' });
    expect(reply.statusCode).toBe(200);
    expect((await alice.json('GET', `/api/portal/tickets/${id}`)).status).toBe('done');
    const notif = await alice.json('GET', '/api/notifications');
    expect(notif.items.some((n: any) => n.title.includes(`n° ${id}`))).toBe(true);
    (globalThis as any).ticketA = { id, attachmentId: t.messages[0].attachments[0].id };
  });

  it('préférences de notification', async () => {
    const r = await alice.json('PATCH', '/api/me', { notify_telegram: true, telegram_chat_id: '123456789', notify_email: false });
    expect(r.user.notify_telegram).toBe(true);
    expect((await alice.req('PATCH', '/api/me', { telegram_chat_id: 'abc' })).statusCode).toBe(400);
  });
});

describe('Cloisonnement : le client B ne peut rien atteindre du client A', () => {
  it('ressources de A demandées par B → introuvable ou refus', async () => {
    const eA = await one<any>(`SELECT id FROM executions WHERE client_id=$1 AND status='error' LIMIT 1`, [kivu.id]);
    const repA = await admin.json('POST', '/api/admin/reports', { client_id: kivu.id, period: currentPeriod() }, 201);
    const { id: ticketId, attachmentId } = (globalThis as any).ticketA;
    const attempts: [string, string, any?][] = [
      ['GET', `/api/portal/workflows/${wfA.id}`],
      ['GET', `/api/portal/workflows/${wfA.id}/executions`],
      ['POST', `/api/portal/workflows/${wfA.id}/deactivate`, {}],
      ['POST', `/api/portal/workflows/${wfA.id}/pause`, { hours: 1 }],
      ['POST', `/api/portal/workflows/${wfA.id}/activate`, {}],
      ['POST', `/api/portal/executions/${eA.id}/retry`, {}],
      ['GET', `/api/portal/reports/${repA.id}/pdf`],
      ['GET', `/api/portal/tickets/${ticketId}`],
      ['POST', `/api/portal/tickets/${ticketId}/messages`, { body: 'intrusion' }],
      ['GET', `/api/portal/attachments/${attachmentId}`],
      ['GET', `/api/clients/${kivu.id}/logo`],
    ];
    for (const [m, url, body] of attempts) {
      const r = await bob.req(m, url, body);
      expect([403, 404], `${m} ${url} → ${r.statusCode}`).toContain(r.statusCode);
    }
    expect(fake.state.workflows.find((x: any) => x.id === '101').active).toBe(true);
    const home = await bob.json('GET', '/api/portal/home');
    expect(home.workflows.map((w: any) => w.id)).not.toContain(wfA.id);
    const tickets = await bob.json('GET', '/api/portal/tickets');
    expect(tickets).toHaveLength(0);
    const reports = await bob.json('GET', '/api/portal/reports');
    expect(reports.every((r: any) => r.id !== repA.id)).toBe(true);
    const bobNotifs = await bob.json('GET', '/api/notifications');
    expect(JSON.stringify(bobNotifs)).not.toContain('Kivu');
  });

  it('toutes les routes agence refusent un compte client (balayage exhaustif)', async () => {
    const adminRoutes = routeTable.filter((r) => r.url.startsWith('/api/admin/'));
    expect(adminRoutes.length).toBeGreaterThan(40);
    const fill = (u: string) => u.replace(/:id/g, '00000000-0000-0000-0000-000000000001').replace(/:action/g, 'x').replace(/:format/g, 'pdf');
    for (const r of adminRoutes) {
      const res = await bob.req(r.method, fill(r.url), {});
      expect([403, 400], `${r.method} ${r.url} → ${res.statusCode}`).toContain(res.statusCode);
      if (res.statusCode === 400) {
        // une validation qui échoue avant le contrôle de rôle serait une fuite : on vérifie avec un identifiant valide
        throw new Error(`${r.method} ${r.url} a validé la requête avant de vérifier le rôle`);
      }
    }
  });

  it('les workflows masqués au client restent invisibles', async () => {
    await admin.json('PATCH', `/api/admin/workflows/${wfB.id}`, { client_visible: false });
    expect((await bob.req('GET', `/api/portal/workflows/${wfB.id}`)).statusCode).toBe(404);
    const home = await bob.json('GET', '/api/portal/home');
    expect(home.workflows.map((w: any) => w.id)).not.toContain(wfB.id);
  });

  it('l’agence ne peut pas être atteinte par un client, ni un client par un anonyme', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/portal/home' })).statusCode).toBe(401);
    expect((await admin.req('GET', '/api/portal/home')).statusCode).toBe(403);
  });
});
