import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';

/**
 * Journal structuré (JSON, une ligne par événement) partagé par le serveur HTTP, le planificateur et les services.
 * Niveaux : info (requêtes), warn (dégradation tolérée), error (incident à regarder). Silencieux pendant les tests.
 * Les en-têtes sensibles et la clé n8n ne sont jamais écrits.
 */
export const log: FastifyBaseLogger = pino({
  level: config.isTest ? 'silent' : 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-n8n-api-key"]'],
});
