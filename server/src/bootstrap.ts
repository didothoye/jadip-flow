import { one, q } from './db.js';
import { ensureDefaultRules } from './services/alerts.js';
import { seedTelegramFromEnv } from './services/telegram.js';

/** Données minimales : client « Interne » et règles d'alerte par défaut. */
export async function bootstrap() {
  await q(`INSERT INTO clients(code, name, is_internal, can_toggle, show_costs) VALUES ('interne','Interne — Jadip Services', true, true, true)
           ON CONFLICT (code) DO NOTHING`);
  await ensureDefaultRules();
  // valeurs initiales du compte Telegram reprises du .env (une seule fois) ; ensuite la base fait foi
  if (await seedTelegramFromEnv()) console.log('Compte Telegram repris des variables d’environnement ; modifiable désormais dans Paramètres › Alertes Telegram.');
  return one<{ n: number }>('SELECT count(*)::int n FROM users WHERE role=$1', ['admin']);
}
