import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variable d'environnement manquante : ${name}`);
}

export interface BrandConfig {
  productName: string;
  companyName: string;
  tagline: string;
  primaryColor: string;
  accentColor: string;
  logoUrl: string;
  supportEmail: string;
  domain: string;
}

const defaultBrand: BrandConfig = {
  productName: 'Jadip Flow',
  companyName: 'Jadip Services',
  tagline: 'Vos automatisations, sous contrôle.',
  primaryColor: '#4f46e5',
  accentColor: '#fbbf24',
  logoUrl: '/brand/logo.svg',
  supportEmail: 'contact@jadipservices.com',
  domain: 'flow.jadipservices.com',
};

function loadBrand(): BrandConfig {
  const p = resolve(process.env.BRAND_CONFIG ?? 'brand.config.json');
  if (existsSync(p)) {
    return { ...defaultBrand, ...JSON.parse(readFileSync(p, 'utf8')) };
  }
  return defaultBrand;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: env('NODE_ENV', 'development'),
  isTest,
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', isTest ? 'postgres://jadip:jadip@localhost:5432/jadip_flow_test' : undefined),
  // rôle propriétaire du schéma, utilisé seulement pour les migrations (l'application tourne avec un rôle restreint)
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL || '',
  // clé maîtresse AES-256 (32 octets en base64) pour chiffrer les secrets au repos
  encryptionKey: env('APP_ENCRYPTION_KEY', isTest ? Buffer.alloc(32, 7).toString('base64') : undefined),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  dataDir: resolve(env('DATA_DIR', './data')),
  webDir: resolve(env('WEB_DIR', '../web/dist')),
  timezone: env('APP_TIMEZONE', 'Africa/Kinshasa'),
  schedulerEnabled: env('SCHEDULER_ENABLED', isTest ? 'false' : 'true') === 'true',
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? '465'),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'Jadip Flow <notifications@jadipservices.com>',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ?? '',
  },
  adminEmail: process.env.ADMIN_NOTIFY_EMAIL ?? '',
  brand: loadBrand(),
};

export type AppConfig = typeof config;
