import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function key(): Buffer {
  const k = Buffer.from(config.encryptionKey, 'base64');
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY doit contenir 32 octets encodés en base64');
  return k;
}

/** Chiffrement AES-256-GCM. Format : v1:iv:tag:données (base64). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(enc: string): string {
  const [v, iv, tag, data] = enc.split(':');
  if (v !== 'v1') throw new Error('Format de secret chiffré inconnu');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hmacSha256 = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Affichage d'un secret sans le révéler : « ••••1234 ». */
export const maskSecret = (s: string) => (s.length <= 4 ? '••••' : `••••${s.slice(-4)}`);
