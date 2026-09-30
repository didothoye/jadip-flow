import './modules.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { bootstrap } from './bootstrap.js';
import { startScheduler, stopScheduler } from './scheduler.js';

async function main() {
  await migrate((m) => console.log(m));
  const admins = await bootstrap();
  if (!admins?.n) console.warn('Aucun administrateur : créez-en un avec « node dist/cli.js create-admin <email> <nom> ».');
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  startScheduler();
  const stop = async () => {
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
