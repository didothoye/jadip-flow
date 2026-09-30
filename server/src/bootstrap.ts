import { one, q } from './db.js';
import { ensureDefaultRules } from './services/alerts.js';

/** Données minimales : client « Interne » et règles d'alerte par défaut. */
export async function bootstrap() {
  await q(`INSERT INTO clients(code, name, is_internal, can_toggle, show_costs) VALUES ('interne','Interne — Jadip Services', true, true, true)
           ON CONFLICT (code) DO NOTHING`);
  await ensureDefaultRules();
  return one<{ n: number }>('SELECT count(*)::int n FROM users WHERE role=$1', ['admin']);
}
