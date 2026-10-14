import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/** Fiche 5 — la page de l'application n'est servie qu'aux navigations ; les sondes de robots reçoivent un 404. */
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jadip-flow-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Jadip Flow</title><div id="root"></div>');
  fs.writeFileSync(path.join(dir, 'robots.txt'), 'User-agent: *\n');
  process.env.WEB_DIR = dir;
});

const { isSpaNavigation } = await import('../src/app.js');
const { makeApp, resetDb } = await import('./helpers.js');

let app: FastifyInstance;
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const get = (url: string, accept = BROWSER) => app.inject({ method: 'GET', url, headers: { accept } });

beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('Interface web (SPA)', () => {
  it('sert la page aux navigations, y compris les adresses profondes', async () => {
    for (const url of ['/', '/connexion', '/agence/workflows', '/agence/workflows/0f1e2d3c-1111-2222-3333-444455556666', '/portail/automatisations?filtre=erreurs']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type'], url).toMatch(/text\/html/);
      expect(r.body, url).toContain('id="root"');
    }
  });

  it('sert les fichiers publiés et répond 404 aux fichiers inconnus', async () => {
    expect((await get('/robots.txt', '*/*')).statusCode).toBe(200);
    for (const url of ['/.git/config', '/backup/.git/config', '/wp-content/.git/config', '/sitemap.xml', '/ads.txt', '/sellers.json', '/.env', '/admin/.git/config']) {
      const r = await get(url, '*/*');
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain('id="root"');
      // même en se faisant passer pour un navigateur, un chemin de fichier ne reçoit pas la page
      expect((await get(url)).statusCode, `${url} (navigateur)`).toBe(404);
    }
  });

  it('ne sert pas la page à un client qui n’attend pas de HTML, ni aux autres méthodes', async () => {
    expect((await get('/agence', '*/*')).statusCode).toBe(404);
    expect((await get('/agence', 'application/json')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/agence', headers: { accept: BROWSER } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/.git/config' })).json()).toEqual({ error: 'Route inconnue', code: 'not_found' });
  });

  it('isSpaNavigation : règles de décision', () => {
    expect(isSpaNavigation('GET', '/agence/clients', BROWSER)).toBe(true);
    expect(isSpaNavigation('HEAD', '/', BROWSER)).toBe(true);
    expect(isSpaNavigation('GET', '/activer/abc.def', BROWSER)).toBe(false);
    expect(isSpaNavigation('GET', '/agence/v1.2', BROWSER)).toBe(false);
    expect(isSpaNavigation('GET', '/agence', undefined)).toBe(false);
  });
});
