import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from '../config.js';
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { parse, z, idParam } from '../lib/validate.js';
import { currentPeriod } from '../lib/time.js';
import { setWorkflowActive } from '../services/actions.js';
import { apiClients, apiCosts, apiErrors, apiExecutions, apiOverview, apiWorkflow, apiWorkflows } from '../services/readapi.js';

const sec = [{ bearer: [] }];
const uuidP = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };
const doc = (tags: string, summary: string, extra: Record<string, unknown> = {}) => ({ schema: { tags: [tags], summary, security: sec, ...extra } });

export default async function apiV1(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      info: { title: `${config.brand.productName} — API`, version: '1.0.0', description: 'API REST de supervision des workflows n8n. Authentification par jeton : « Authorization: Bearer jf_… ». Les jetons d’un compte client sont limités à ce client. Limite : 120 requêtes par minute et par jeton.' },
      servers: [{ url: config.publicUrl }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: ({ schema, url }) => ({ schema: (url.startsWith('/api/v1') ? schema : { ...(schema ?? {}), hide: true }) as any, url }),
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'list' } });

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/v1/') && req.actor && req.actor.source !== 'web') {
      await audit({ actorUserId: req.actor.userId, actorLabel: req.actor.label, source: 'api', action: 'api.request', targetType: 'route', targetId: `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`, clientId: req.actor.clientId, ip: req.ip });
    }
  });

  app.get('/api/v1/overview', doc('Supervision', 'Vue d’ensemble (flotte, alertes ouvertes, clients à risque)'), async (req) => apiOverview(requireUser(req)));

  app.get('/api/v1/clients', doc('Clients', 'Liste des clients et de leurs indicateurs'), async (req) => apiClients(requireUser(req)));

  app.get('/api/v1/workflows', doc('Workflows', 'Liste des workflows', { querystring: { type: 'object', properties: { client_id: { type: 'string', format: 'uuid' }, search: { type: 'string' } } } }), async (req) => {
    const a = requireUser(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional(), search: z.string().max(100).optional() }), req.query);
    return apiWorkflows(a, { clientId: f.client_id, search: f.search });
  });

  app.get('/api/v1/workflows/:id', doc('Workflows', 'Détail d’un workflow et dernières erreurs', { params: uuidP }), async (req) => apiWorkflow(requireUser(req), parse(idParam, req.params).id));

  for (const action of ['activate', 'deactivate'] as const) {
    app.post(`/api/v1/workflows/:id/${action}`, doc('Actions', action === 'activate' ? 'Activer un workflow (portée « write »)' : 'Désactiver un workflow (portée « write »)', { params: uuidP }), async (req) => {
      const a = requireUser(req);
      return setWorkflowActive(a, parse(idParam, req.params).id, action === 'activate');
    });
  }

  app.get('/api/v1/executions', doc('Exécutions', 'Exécutions (métadonnées), paginées par curseur', {
    querystring: { type: 'object', properties: { client_id: { type: 'string' }, workflow_id: { type: 'string' }, status: { type: 'string', description: 'success, error, failed, running…' }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' }, cursor: { type: 'string' }, limit: { type: 'integer', maximum: 200 } } },
  }), async (req) => {
    const a = requireUser(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional(), workflow_id: z.string().uuid().optional(), status: z.string().max(20).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    return apiExecutions(a, { clientId: f.client_id, workflowId: f.workflow_id, status: f.status, from: f.from, to: f.to, cursor: f.cursor, limit: f.limit });
  });

  app.get('/api/v1/errors', doc('Exécutions', 'Erreurs récentes classées', {
    querystring: { type: 'object', properties: { client_id: { type: 'string' }, workflow_id: { type: 'string' }, category: { type: 'string', enum: ['auth', 'rate_limit', 'network', 'data', 'logic'] }, unhandled: { type: 'boolean' }, limit: { type: 'integer', maximum: 500 } } },
  }), async (req) => {
    const a = requireUser(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional(), workflow_id: z.string().uuid().optional(), category: z.string().max(20).optional(), unhandled: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
    return apiErrors(a, { clientId: f.client_id, workflowId: f.workflow_id, category: f.category, unhandled: f.unhandled, limit: f.limit });
  });

  app.get('/api/v1/costs', doc('Coûts', 'Coûts IA par client, workflow, modèle et jour', {
    querystring: { type: 'object', properties: { client_id: { type: 'string' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } },
  }), async (req) => {
    const a = requireUser(req);
    const f = parse(z.object({ client_id: z.string().uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    return apiCosts(a, { clientId: f.client_id, from: f.from ?? `${currentPeriod()}-01`, to: f.to ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
  });
}
