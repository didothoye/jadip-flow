import { one, q } from '../db.js';
import { defaultTelegramAlerts } from './alert-types.js';

export interface AppSettings {
  quietHours: { enabled: boolean; start: string; end: string }; // HH:MM, fuseau de l'application
  atRisk: { inactivityDays: number; failureRatePct: number; minExecutions: number };
  sync: { maxInitialExecutions: number; errorDetailsPerSync: number };
  reports: { autoSendDay: number };
  notifyAdminOnClientAction: boolean;
  /** Types d'alertes relayés sur Telegram (clé = kind, voir alert-types.ts). */
  telegramAlerts: Record<string, boolean>;
}

export const defaultSettings: AppSettings = {
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  atRisk: { inactivityDays: 3, failureRatePct: 20, minExecutions: 5 },
  sync: { maxInitialExecutions: 20000, errorDetailsPerSync: 100 },
  reports: { autoSendDay: 1 },
  notifyAdminOnClientAction: true,
  telegramAlerts: defaultTelegramAlerts(),
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await q<{ key: string; value: any }>('SELECT key, value FROM settings');
  const s: any = structuredClone(defaultSettings);
  for (const r of rows) {
    if (!(r.key in s)) continue;
    s[r.key] = typeof s[r.key] === 'object' && s[r.key] !== null ? { ...s[r.key], ...r.value } : r.value;
  }
  return s;
}

/** Vrai si ce type d'alerte doit partir sur Telegram (inconnu = non). */
export async function telegramEnabledFor(kind: string): Promise<boolean> {
  const s = await getSettings();
  return s.telegramAlerts[kind] === true;
}

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await q('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}

export async function getSettingRaw(key: string): Promise<any> {
  return (await one<{ value: any }>('SELECT value FROM settings WHERE key=$1', [key]))?.value ?? null;
}
