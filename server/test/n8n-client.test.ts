import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { N8nClient, N8nError } from '../src/n8n/client.js';

/**
 * Fiche 2 — un n8n qui redémarre (404 sans corps JSON, passerelle 503, connexion refusée) est réessayé une fois ;
 * une erreur franche (clé refusée, ressource absente) ne l'est pas, et le message nomme l'opération.
 */
type Reply = { status: number; body?: string; json?: unknown };
const servers: http.Server[] = [];

/** Serveur qui rejoue une séquence de réponses, puis répond toujours la dernière. */
async function serve(seq: Reply[]) {
  const requests: string[] = [];
  const s = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const r = seq[Math.min(requests.length, seq.length) - 1];
    if (r.json !== undefined) { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }
    else { res.writeHead(r.status, { 'content-type': 'text/html' }); res.end(r.body ?? ''); }
  });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(s.address() as any).port}`, requests };
}

afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

const page = { data: [{ id: '1', name: 'A', active: true, tags: [] }], nextCursor: null };
const client = (url: string) => new N8nClient(url, 'cle', 2000, 30);
const list = async (c: N8nClient) => { const out = []; for await (const w of c.workflows()) out.push(w); return out; };

describe('Client n8n — erreurs transitoires', () => {
  it('réessaie une fois après un 404 sans corps JSON (n8n en cours de démarrage)', async () => {
    const s = await serve([{ status: 404, body: '<html>Not Found</html>' }, { status: 200, json: page }]);
    expect((await list(client(s.url))).length).toBe(1);
    expect(s.requests.length).toBe(2);
  });

  it('réessaie après un 503 puis remonte une erreur explicite si n8n ne revient pas', async () => {
    const s = await serve([{ status: 503, body: 'Service Unavailable' }]);
    const err = await list(client(s.url)).catch((e) => e);
    expect(err).toBeInstanceOf(N8nError);
    expect(err.transient).toBe(true);
    expect(err.message).toBe('n8n indisponible (redémarrage probable) : liste des workflows → 503 Service Unavailable');
    expect(s.requests.length).toBe(2);
  });

  it('réessaie une connexion refusée et nomme l’opération', async () => {
    const s = await serve([{ status: 200, json: page }]);
    const url = s.url;
    await new Promise((r) => servers.pop()!.close(r)); // port fermé : connexion refusée
    const err = await list(client(url)).catch((e) => e);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/^n8n injoignable : liste des workflows → réseau : ECONNREFUSED/);
  });

  it('ne réessaie pas une clé refusée, ni un 404 documenté par n8n', async () => {
    const s = await serve([{ status: 401, json: { message: 'unauthorized' } }]);
    const err = await list(client(s.url)).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.transient).toBe(false);
    expect(err.message).toBe('liste des workflows → 401 Unauthorized — unauthorized');
    expect(s.requests.length).toBe(1);
    const s2 = await serve([{ status: 404, json: { message: 'Not Found' } }]);
    const err2 = await client(s2.url).errorSummary('42').catch((e) => e);
    expect(err2.transient).toBe(false);
    expect(err2.message).toBe('détail de l’exécution 42 → 404 Not Found — Not Found');
    expect(s2.requests.length).toBe(1);
  });

  it('ne réessaie jamais une écriture (activation), ni la sonde de connexion', async () => {
    const s = await serve([{ status: 503, body: '' }]);
    await expect(client(s.url).activate('1')).rejects.toThrow(/activation du workflow → 503/);
    expect(s.requests.length).toBe(1);
    const h = await client(s.url).health();
    expect(h).toEqual({ reachable: false, authOk: false, message: 'n8n indisponible (redémarrage probable) : test de connexion → 503 Service Unavailable' });
    expect(s.requests.length).toBe(2);
  });
});
