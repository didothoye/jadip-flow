// Faux serveur n8n (API publique v1) pour les tests automatisés et l'instance de démonstration.
// Aucune dépendance : node fake-n8n.mjs  (PORT, API_KEY, SEED, DAYS)
import http from 'node:http';

const ERRORS = [
  { node: 'OpenAI', message: 'Request failed with status code 429 — Rate limit reached for gpt-4o-mini' },
  { node: 'Google Sheets', message: 'The caller does not have permission (403) — invalid_grant: Token has been expired or revoked.' },
  { node: 'HTTP Request', message: 'connect ETIMEDOUT 102.68.12.4:443' },
  { node: 'Code', message: "Cannot read properties of undefined (reading 'telephone')" },
  { node: 'IF', message: 'Workflow stopped: aucune règle ne correspond au statut reçu' },
  { node: 'WhatsApp', message: 'Unauthorized: invalid access token' },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function demoWorkflows() {
  return [
    { id: '101', name: 'Kivu — Commandes WhatsApp vers Google Sheets', active: true, tags: ['client:demo-kivu', 'production'], perDay: 24, fail: 0.04 },
    { id: '102', name: 'Kivu — Relance des factures impayées', active: true, tags: ['client:demo-kivu'], perDay: 3, fail: 0.02 },
    { id: '103', name: 'Kivu — Résumé IA des avis clients', active: true, tags: ['client:demo-kivu', 'ia'], perDay: 6, fail: 0.18 },
    { id: '201', name: 'Lumière — Tri IA des e-mails entrants', active: true, tags: ['client:demo-lumiere', 'ia'], perDay: 40, fail: 0.03 },
    { id: '202', name: 'Lumière — Rendez-vous Calendly vers CRM', active: true, tags: ['client:demo-lumiere'], perDay: 8, fail: 0.01 },
    { id: '203', name: 'Lumière — Rapport hebdomadaire des dossiers', active: false, tags: ['client:demo-lumiere'], perDay: 0.14, fail: 0 },
    { id: '301', name: 'Jadip — Veille des appels d’offres', active: true, tags: ['client:interne'], perDay: 4, fail: 0.05 },
    { id: '302', name: 'Jadip — Sauvegarde n8n vers Drive', active: true, tags: ['client:interne', 'critique'], perDay: 1, fail: 0 },
    { id: '401', name: 'Brouillon — Test webhook', active: false, tags: [], perDay: 0, fail: 0 },
  ];
}

export function createFakeN8n({ apiKey = 'fake-key', workflows = demoWorkflows(), days = 30, seed = 42, retry = true } = {}) {
  const rand = rng(seed);
  const state = {
    workflows: workflows.map((w) => ({
      id: w.id, name: w.name, active: w.active, isArchived: false,
      createdAt: new Date(Date.now() - 90 * 86400000).toISOString(), updatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      tags: w.tags.map((t, i) => ({ id: `${w.id}${i}`, name: t })), nodes: [{ name: 'secret-node', parameters: { apiKey: 'NE-DOIT-PAS-ETRE-STOCKE' } }],
      _perDay: w.perDay, _fail: w.fail,
    })),
    executions: [],
    nextId: 1,
    requests: [],
  };
  const addExecution = (wf, startedAt, status, err) => {
    const dur = Math.round(500 + rand() * 20000);
    state.executions.push({
      id: String(state.nextId++), workflowId: wf.id, mode: rand() < 0.8 ? 'trigger' : 'webhook', finished: status === 'success',
      retryOf: null, retrySuccessId: null, startedAt: new Date(startedAt).toISOString(),
      stoppedAt: status === 'running' ? null : new Date(startedAt + dur).toISOString(), status,
      _error: err ?? null, _data: { client: 'Données personnelles à ne jamais importer', telephone: '+243 000 000 000' },
    });
  };
  const now = Date.now();
  for (const wf of state.workflows) {
    const total = Math.round(wf._perDay * days);
    for (let i = 0; i < total; i++) {
      const t = now - rand() * days * 86400000;
      const failed = rand() < wf._fail;
      addExecution(wf, t, failed ? 'error' : 'success', failed ? ERRORS[Math.floor(rand() * ERRORS.length)] : null);
    }
  }
  state.executions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  state.executions.forEach((e, i) => (e.id = String(i + 1)));
  state.nextId = state.executions.length + 1;

  const api = {
    state,
    addExecution: (wfId, status = 'success', err = null, at = Date.now()) => {
      addExecution(state.workflows.find((w) => w.id === wfId), at, status, err);
      return state.executions[state.executions.length - 1];
    },
  };

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const pub = (w) => ({ id: w.id, name: w.name, active: w.active, isArchived: w.isArchived, createdAt: w.createdAt, updatedAt: w.updatedAt, tags: w.tags, nodes: w.nodes, connections: {} });
  const pubExec = (e, withData) => {
    const { _error, _data, ...rest } = e;
    if (!withData) return rest;
    return { ...rest, data: { resultData: { runData: { Trigger: [{ data: _data }] }, lastNodeExecuted: _error?.node ?? 'Trigger',
      error: _error ? { message: _error.message, node: { name: _error.node, parameters: { secret: 'x' } } } : undefined } } };
  };
  const paginate = (list, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 250);
    const offset = Number(url.searchParams.get('cursor') ? Buffer.from(url.searchParams.get('cursor'), 'base64').toString() : 0);
    const data = list.slice(offset, offset + limit);
    const next = offset + limit < list.length ? Buffer.from(String(offset + limit)).toString('base64') : null;
    return { data, nextCursor: next };
  };

  api.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
    if (req.headers['x-n8n-api-key'] !== apiKey) return send(res, 401, { message: 'unauthorized' });
    let m;
    if (req.method === 'GET' && url.pathname === '/api/v1/workflows') {
      return send(res, 200, paginate(state.workflows.filter((w) => !w._deleted).map(pub), url));
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/workflows\/([^/]+)\/(activate|deactivate)$/.exec(url.pathname))) {
      const w = state.workflows.find((x) => x.id === m[1] && !x._deleted);
      if (!w) return send(res, 404, { message: 'Not Found' });
      w.active = m[2] === 'activate';
      w.updatedAt = new Date().toISOString();
      return send(res, 200, pub(w));
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/executions') {
      let list = [...state.executions].reverse();
      const wf = url.searchParams.get('workflowId');
      if (wf) list = list.filter((e) => e.workflowId === wf);
      const includeData = url.searchParams.get('includeData') === 'true';
      const page = paginate(list, url);
      return send(res, 200, { data: page.data.map((e) => pubExec(e, includeData)), nextCursor: page.nextCursor });
    }
    if (req.method === 'GET' && (m = /^\/api\/v1\/executions\/([^/]+)$/.exec(url.pathname))) {
      const e = state.executions.find((x) => x.id === m[1]);
      if (!e) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, pubExec(e, url.searchParams.get('includeData') === 'true'));
    }
    if (req.method === 'POST' && (m = /^\/api\/v1\/executions\/([^/]+)\/retry$/.exec(url.pathname))) {
      if (!retry) return send(res, 404, { message: 'Cannot POST /api/v1/executions/' + m[1] + '/retry' });
      const e = state.executions.find((x) => x.id === m[1]);
      if (!e) return send(res, 404, { message: 'Not Found' });
      const wf = state.workflows.find((w) => w.id === e.workflowId);
      const n = api.addExecution(wf.id, 'success');
      n.retryOf = e.id;
      n.mode = 'retry';
      e.retrySuccessId = n.id;
      return send(res, 200, pubExec(n, false));
    }
    return send(res, 404, { message: 'Not Found' });
  });
  api.listen = (port = 0) => new Promise((r) => api.server.listen(port, '127.0.0.1', () => r(api.server.address().port)));
  api.close = () => new Promise((r) => api.server.close(() => r()));
  return api;
}

// Mode autonome : instance de démonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = createFakeN8n({ apiKey: process.env.API_KEY ?? 'demo-key', days: Number(process.env.DAYS ?? 30), seed: Number(process.env.SEED ?? 42) });
  const port = Number(process.env.PORT ?? 5678);
  fake.server.listen(port, '0.0.0.0', () => console.log(`Faux n8n de démonstration sur :${port} (${fake.state.executions.length} exécutions)`));
  // activité continue : une exécution toutes les 2 minutes environ
  setInterval(() => {
    const active = fake.state.workflows.filter((w) => w.active && w._perDay > 0);
    const w = active[Math.floor(Math.random() * active.length)];
    const failed = Math.random() < w._fail;
    fake.addExecution(w.id, failed ? 'error' : 'success', failed ? ERRORS[Math.floor(Math.random() * ERRORS.length)] : null);
  }, 120000);
}
