import './modules.js';
import { migrate, one, pool } from './db.js';
import { bootstrap } from './bootstrap.js';
import { hashPassword, validatePassword, createUserToken } from './auth.js';
import { config } from './config.js';
import { runJobByName, listJobs } from './scheduler.js';
import { verifyAuditChain } from './audit.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'migrate':
      await migrate(console.log);
      await bootstrap();
      console.log('Base à jour.');
      break;
    case 'create-admin': {
      const [email, ...nameParts] = args;
      if (!email) throw new Error('Usage : create-admin <email> <nom>');
      await migrate();
      await bootstrap();
      const name = nameParts.join(' ') || 'Administrateur';
      const pw = process.env.ADMIN_PASSWORD;
      if (pw) {
        const err = validatePassword(pw);
        if (err) throw new Error(err);
      }
      const u = await one<{ id: string }>(`INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,'admin',$3)
        ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, password_hash=COALESCE(EXCLUDED.password_hash, users.password_hash) RETURNING id`,
        [email, name, pw ? await hashPassword(pw) : null]);
      if (!pw) {
        const token = await createUserToken(u!.id, 'invite', 72);
        console.log(`Administrateur créé. Lien d'activation (72 h) :\n${config.publicUrl}/activer/${token}`);
      } else console.log('Administrateur créé avec le mot de passe fourni.');
      break;
    }
    case 'run-job':
      console.log(await runJobByName(args[0]));
      break;
    case 'jobs':
      console.log(listJobs().join('\n'));
      break;
    case 'verify-audit':
      console.log(await verifyAuditChain());
      break;
    default:
      console.log('Commandes : migrate | create-admin <email> <nom> | run-job <nom> | jobs | verify-audit');
  }
}

main().then(() => pool.end()).catch(async (e) => {
  console.error(e.message ?? e);
  await pool.end();
  process.exit(1);
});
