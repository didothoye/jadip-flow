import type { FastifyInstance } from 'fastify';
import '../src/modules.js';
import { buildApp } from '../src/app.js';
import { migrate, pool, q } from '../src/db.js';
import { bootstrap } from '../src/bootstrap.js';
import { hashPassword } from '../src/auth.js';
// @ts-expect-error module JS sans types
import { createFakeN8n } from '../../tools/fake-n8n/fake-n8n.mjs';

export { createFakeN8n };

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await bootstrap();
}

export const PASSWORD = 'MotDePasse123';

export async function createUser(email: string, role: 'admin' | 'client', clientId: string | null = null) {
  const rows = await q<{ id: string }>(`INSERT INTO users(email, name, role, client_id, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [email, email.split('@')[0], role, clientId, await hashPassword(PASSWORD)]);
  return rows[0].id;
}

export class Session {
  cookie = '';
  constructor(public app: FastifyInstance) {}
  async login(email: string, password = PASSWORD) {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const set = r.headers['set-cookie'];
    const c = Array.isArray(set) ? set[0] : set;
    if (c) this.cookie = c.split(';')[0];
    return r;
  }
  req(method: string, url: string, payload?: unknown) {
    return this.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie: this.cookie, 'x-jf-csrf': '1' } });
  }
  async json(method: string, url: string, payload?: unknown, expected = 200) {
    const r = await this.req(method, url, payload);
    if (r.statusCode !== expected) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  }
}

export async function makeApp() {
  return buildApp({ logger: false });
}
