import { config } from '../config.js';
import { one, q } from '../db.js';
import { decrypt, encrypt, maskSecret } from '../lib/crypto.js';

/**
 * Compte Telegram de l'agence (robot + discussion destinataire).
 * Source de vérité : la table « settings » (clé « telegram_channel »), jeton chiffré au repos.
 * Les variables d'environnement ne servent que de valeurs initiales (reprises une fois au démarrage).
 */

const SETTING_KEY = 'telegram_channel';
const CACHE_MS = 15_000;

export interface TelegramConfig { botToken: string; chatId: string; source: 'db' | 'env' | 'none' }
interface StoredTelegram { botTokenEnc: string | null; chatId: string | null; updatedAt?: string }

export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
export const CHAT_ID_RE = /^-?\d{3,20}$/;

let cache: { at: number; value: TelegramConfig } | null = null;
export const invalidateTelegramCache = () => { cache = null; };

async function readStored(): Promise<StoredTelegram | null> {
  return (await one<{ value: StoredTelegram }>('SELECT value FROM settings WHERE key=$1', [SETTING_KEY]))?.value ?? null;
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const stored = await readStored();
  let value: TelegramConfig;
  if (stored) {
    value = { botToken: stored.botTokenEnc ? decrypt(stored.botTokenEnc) : '', chatId: stored.chatId ?? '', source: 'db' };
  } else if (config.telegram.botToken || config.telegram.adminChatId) {
    value = { botToken: config.telegram.botToken, chatId: config.telegram.adminChatId, source: 'env' };
  } else {
    value = { botToken: '', chatId: '', source: 'none' };
  }
  cache = { at: Date.now(), value };
  return value;
}

export const isTelegramConfigured = async () => { const c = await getTelegramConfig(); return !!(c.botToken && c.chatId); };

/** Résumé sans secret pour l'interface : le jeton n'est jamais renvoyé, seuls ses 4 derniers caractères le sont. */
export async function describeTelegramConfig() {
  const c = await getTelegramConfig();
  return { configured: !!(c.botToken && c.chatId), tokenMasked: c.botToken ? maskSecret(c.botToken) : null, chatId: c.chatId || null, source: c.source };
}

/**
 * Enregistre le compte. `botToken` : undefined = conserver, '' ou null = effacer, sinon remplacer.
 * `chatId` : undefined = conserver, '' ou null = effacer.
 */
export async function saveTelegramConfig(input: { botToken?: string | null; chatId?: string | null }) {
  const current = await getTelegramConfig();
  const token = input.botToken === undefined ? current.botToken : (input.botToken ?? '').trim();
  const chatId = input.chatId === undefined ? current.chatId : (input.chatId ?? '').trim();
  const stored: StoredTelegram = { botTokenEnc: token ? encrypt(token) : null, chatId: chatId || null, updatedAt: new Date().toISOString() };
  await q('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [SETTING_KEY, JSON.stringify(stored)]);
  invalidateTelegramCache();
  return describeTelegramConfig();
}

/** Au premier démarrage : reprend les valeurs du .env comme valeurs initiales ; ensuite la base fait foi. */
export async function seedTelegramFromEnv() {
  if (await readStored()) return false;
  if (!config.telegram.botToken && !config.telegram.adminChatId) return false;
  await saveTelegramConfig({ botToken: config.telegram.botToken, chatId: config.telegram.adminChatId });
  return true;
}

/** Retire le jeton d'un texte (message d'erreur, URL) avant journalisation. */
export function redactToken(text: string, token: string) {
  return token ? text.split(token).join('••••') : text;
}

/** Traduit la réponse d'erreur de l'API Telegram en explication exploitable par l'administrateur. */
export function describeTelegramError(status: number, body: string): string {
  let description = '';
  try { description = String(JSON.parse(body)?.description ?? ''); } catch { description = body; }
  const d = description.toLowerCase();
  if (status === 401 || d.includes('unauthorized')) return 'Jeton du bot invalide ou révoqué : vérifiez-le auprès de @BotFather.';
  if (d.includes('chat not found')) return 'Discussion introuvable : vérifiez l’identifiant. Pour un compte, l’utilisateur doit d’abord envoyer /start au bot ; pour un groupe, le bot doit y avoir été ajouté (identifiant commençant par -100).';
  if (d.includes("can't initiate conversation") || d.includes('bot was blocked')) return 'Le bot ne peut pas écrire à cet utilisateur : il doit d’abord lui envoyer /start (ou le débloquer).';
  if (d.includes('kicked') || d.includes('not a member') || d.includes('not enough rights')) return 'Le bot a été retiré du groupe ou n’a pas le droit d’y écrire.';
  if (status === 429) return 'Telegram limite le débit : réessayez dans quelques instants.';
  return `Telegram a refusé l’envoi (${status})${description ? ` : ${description.slice(0, 200)}` : ''}.`;
}

/** Envoi direct (sans file d'attente). Jamais de jeton dans les erreurs levées. */
export async function sendTelegram(chatId: string, html: string, token?: string) {
  const cfg = token ? null : await getTelegramConfig();
  const t = token ?? cfg!.botToken;
  if (!t) throw new Error('Bot Telegram non configuré : renseignez le jeton dans Paramètres › Alertes Telegram.');
  if (!chatId) throw new Error('Aucune discussion Telegram destinataire configurée.');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e: any) {
    throw new Error(`Telegram injoignable : ${redactToken(String(e?.cause?.message ?? e?.message ?? e), t).slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(redactToken(describeTelegramError(res.status, await res.text()), t));
}
