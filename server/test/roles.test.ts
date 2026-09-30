import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

/** En production, l'application tourne avec un rôle restreint : le journal d'audit reste inaltérable même pour elle. */
describe('Rôle applicatif restreint', () => {
  it('migre avec le rôle propriétaire ; le rôle applicatif ne peut ni modifier l’audit ni désactiver ses déclencheurs', async () => {
    const admin = new pg.Client({ connectionString: 'postgres://jadip:jadip@localhost:5432/postgres' });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS jadip_flow_roles');
    await admin.query('CREATE DATABASE jadip_flow_roles');
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jf_app_test') THEN CREATE ROLE jf_app_test LOGIN PASSWORD 'apptest'; END IF; END $$`);
    await admin.end();
    execFileSync('npx', ['tsx', 'src/cli.ts', 'migrate'], {
      env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgres://jf_app_test:apptest@localhost:5432/jadip_flow_roles',
        MIGRATION_DATABASE_URL: 'postgres://jadip:jadip@localhost:5432/jadip_flow_roles', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') },
      stdio: 'pipe',
    });
    const app = new pg.Client({ connectionString: 'postgres://jf_app_test:apptest@localhost:5432/jadip_flow_roles' });
    await app.connect();
    await app.query(`INSERT INTO audit_log(source, action, prev_hash, hash) VALUES ('system','test','','')`);
    const n = await app.query('SELECT count(*)::int n FROM clients');
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1); // client « Interne » créé
    await expect(app.query(`UPDATE audit_log SET action='x'`)).rejects.toThrow(/permission|denied/i);
    await expect(app.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission|denied/i);
    await expect(app.query(`ALTER TABLE audit_log DISABLE TRIGGER USER`)).rejects.toThrow(/owner|must be/i);
    await expect(app.query(`TRUNCATE audit_log`)).rejects.toThrow(/permission|denied/i);
    await app.end();
  });
});
