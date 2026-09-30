import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';
import { registerAuth } from './auth.js';
import { HttpError } from './lib/errors.js';
import authRoutes from './routes/auth.js';
import instanceRoutes from './routes/admin/instances.js';
import clientRoutes from './routes/admin/clients.js';
import workflowRoutes from './routes/admin/workflows.js';
import alertRoutes from './routes/admin/alerts.js';
import systemRoutes from './routes/admin/system.js';

type RouteModule = (app: FastifyInstance) => Promise<void>;
const extraRoutes: RouteModule[] = [];
/** Permet aux modules des phases suivantes de s'enregistrer. */
export const registerRoutes = (...m: RouteModule[]) => extraRoutes.push(...m);

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? !config.isTest ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-n8n-api-key"]'] } : false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5 } });
  await app.register(rateLimit, {
    global: true,
    max: (req) => (req.headers.authorization ? 120 : 600),
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers.authorization ? `tok:${req.headers.authorization.slice(-16)}` : req.ip),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, code: 'rate_limited', error: 'Trop de requêtes', message: `Limite atteinte, réessayez dans ${Math.ceil(ctx.ttl / 1000)} s.` }),
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    if (err.statusCode === 429) return reply.code(429).send({ error: err.message, code: 'rate_limited' });
    if (err.validation) return reply.code(400).send({ error: 'Requête invalide', code: 'bad_request' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code ?? 'error' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Erreur interne. L’incident a été journalisé.', code: 'internal' });
  });

  registerAuth(app);

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', service: 'jadip-flow', time: new Date().toISOString() };
  });

  for (const r of [authRoutes, instanceRoutes, clientRoutes, workflowRoutes, alertRoutes, systemRoutes, ...extraRoutes]) await app.register(r);

  // interface web (SPA)
  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: false });
    const index = join(config.webDir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) return reply.code(404).send({ error: 'Route inconnue', code: 'not_found' });
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html', config.webDir);
    });
    app.get('/', (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html', config.webDir));
    void index;
  }
  return app;
}
