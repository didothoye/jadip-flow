/**
 * Jeu de démonstration : deux clients fictifs, une instance n8n de test, comptes, demandes, coûts, rapports.
 * Usage : DEMO_N8N_URL=http://localhost:5678 DEMO_N8N_KEY=demo-key node dist/demo.js
 * (le faux n8n est fourni par tools/fake-n8n/fake-n8n.mjs)
 */
import './modules.js';
import { migrate, one, pool, q } from './db.js';
import { bootstrap } from './bootstrap.js';
import { hashPassword } from './auth.js';
import { encrypt } from './lib/crypto.js';
import { syncInstance } from './services/sync.js';
import { evaluatePeriodic } from './services/alerts.js';
import { computeEstimates } from './services/llm/costs.js';
import { generateReport } from './services/reports.js';
import { currentPeriod, previousPeriod } from './lib/time.js';

const url = process.env.DEMO_N8N_URL ?? 'http://localhost:5678';
const key = process.env.DEMO_N8N_KEY ?? 'demo-key';
const pw = process.env.DEMO_PASSWORD ?? 'Demo2026Jadip';

async function user(email: string, name: string, role: 'admin' | 'client', clientId: string | null) {
  return one<{ id: string }>(`INSERT INTO users(email, name, role, client_id, password_hash) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [email, name, role, clientId, await hashPassword(pw)]);
}

async function main() {
  await migrate();
  await bootstrap();
  const kivu = await one<any>(`INSERT INTO clients(code, name, contact_name, contact_email, notes, can_toggle, can_retry, show_costs, show_reports, monthly_budget_usd, monthly_fee_usd, report_email_enabled, report_emails)
    VALUES ('demo-kivu','Boulangerie Kivu (démo)','Aline Mbuyi','aline@kivu.example','Client fictif de démonstration.', true, true, true, true, 25, 180, true, '{aline@kivu.example}')
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING *`);
  const lum = await one<any>(`INSERT INTO clients(code, name, contact_name, contact_email, notes, can_toggle, can_retry, show_costs, show_reports, monthly_budget_usd, monthly_fee_usd)
    VALUES ('demo-lumiere','Cabinet Lumière (démo)','Me Patrick Ilunga','patrick@lumiere.example','Client fictif de démonstration.', true, false, false, true, 40, 250)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING *`);
  await user('demo-agence@jadipservices.com', 'Agence (démo)', 'admin', null);
  await user('aline@kivu.example', 'Aline Mbuyi', 'client', kivu.id);
  await user('patrick@lumiere.example', 'Patrick Ilunga', 'client', lum.id);

  let inst = await one<any>(`SELECT id FROM instances WHERE name='n8n de démonstration'`);
  if (!inst) {
    inst = await one<any>(`INSERT INTO instances(name, base_url, public_url, api_key_enc, retention_days) VALUES ('n8n de démonstration',$1,$1,$2,90) RETURNING id`, [url, encrypt(key)]);
  }
  const s = await syncInstance(inst.id, 'manual');
  console.log('Synchronisation :', s);

  const meta: Record<string, [string, string, number, number?]> = {
    '101': ['Commandes WhatsApp', 'Chaque commande reçue sur WhatsApp est ajoutée automatiquement au tableau des commandes du jour.', 4],
    '102': ['Relance des factures', 'Les clients dont la facture est impayée depuis 7 jours reçoivent un rappel poli par e-mail.', 6],
    '103': ['Résumé des avis clients', 'Les avis Google de la semaine sont lus et résumés par l’IA en trois points à retenir.', 15, 0.004],
    '201': ['Tri des e-mails entrants', 'Chaque e-mail reçu est classé (dossier, urgence, facturation) et transmis à la bonne personne.', 3, 0.0015],
    '202': ['Rendez-vous vers le CRM', 'Les rendez-vous pris en ligne sont créés automatiquement dans le CRM avec la fiche du client.', 5],
    '203': ['Rapport hebdomadaire des dossiers', 'Chaque lundi, un point sur l’avancement des dossiers est envoyé aux associés.', 45],
    '301': ['Veille des appels d’offres', 'Surveillance quotidienne des appels d’offres publiés.', 20, 0.01],
    '302': ['Sauvegarde n8n', 'Sauvegarde quotidienne des workflows vers Google Drive.', 10],
  };
  for (const [id, [name, desc, minutes, cost]] of Object.entries(meta)) {
    await q(`UPDATE workflows SET display_name=$2, description=$3, minutes_saved_per_execution=$4, cost_per_execution_usd=$5 WHERE n8n_id=$1 AND instance_id=$6`,
      [id, name, desc, minutes, cost ?? 0, inst.id]);
  }
  await q(`UPDATE workflows SET is_locked=true WHERE n8n_id='302' AND instance_id=$1`, [inst.id]);

  // coûts : saisie manuelle d'exemple + estimations par exécution
  const has = await one<any>(`SELECT 1 FROM llm_usage WHERE source='manual'`);
  if (!has) {
    for (let d = 0; d < 20; d++) {
      const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      await q(`INSERT INTO llm_usage(source, day, provider, model, cost_usd, client_id, note) VALUES ('manual',$1,'openai','gpt-4o-mini',$2,$3,'Démonstration')`, [day, 0.3 + Math.random() * 0.6, kivu.id]);
    }
  }
  await computeEstimates(60);

  // demandes
  if (!(await one('SELECT 1 FROM tickets'))) {
    const aline = await one<any>(`SELECT id FROM users WHERE email='aline@kivu.example'`);
    const wf = await one<any>(`SELECT id FROM workflows WHERE n8n_id='101' AND instance_id=$1`, [inst.id]);
    const t = await one<any>(`INSERT INTO tickets(client_id, workflow_id, created_by, kind, subject, status) VALUES ($1,$2,$3,'change','Ajouter la quantité commandée dans le tableau','in_progress') RETURNING id`, [kivu.id, wf.id, aline.id]);
    await q(`INSERT INTO ticket_messages(ticket_id, author_id, author_role, body) VALUES ($1,$2,'client','Bonjour, pourriez-vous ajouter une colonne « quantité » dans le tableau des commandes ? Merci !')`, [t.id, aline.id]);
    await q(`INSERT INTO ticket_messages(ticket_id, author_role, body) VALUES ($1,'admin','Bien reçu, c’est prévu pour jeudi. Nous vous prévenons dès que c’est en place.')`, [t.id]);
    const t2 = await one<any>(`INSERT INTO tickets(client_id, created_by, kind, subject) VALUES ($1,$2,'question','Peut-on recevoir les commandes aussi par SMS ?') RETURNING id`, [kivu.id, aline.id]);
    await q(`INSERT INTO ticket_messages(ticket_id, author_id, author_role, body) VALUES ($1,$2,'client','Certains clients n’ont pas WhatsApp. Est-il possible de prendre leurs commandes par SMS ?')`, [t2.id, aline.id]);
  }
  await evaluatePeriodic();
  for (const c of [kivu, lum]) {
    await generateReport(c.id, previousPeriod());
    await generateReport(c.id, currentPeriod());
  }
  console.log(`Démo prête.\n  Agence : demo-agence@jadipservices.com\n  Client A : aline@kivu.example\n  Client B : patrick@lumiere.example\n  Mot de passe : ${pw}`);
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
