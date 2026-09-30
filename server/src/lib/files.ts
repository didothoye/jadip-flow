import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { config } from '../config.js';
import { randomToken } from './crypto.js';
import { badRequest } from './errors.js';

export const ALLOWED_ATTACHMENT = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|text\/csv|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/msword|application\/vnd\.ms-excel)$/;
export const ALLOWED_LOGO = /^image\/(png|jpeg|webp|svg\+xml)$/;

export function dataPath(...parts: string[]) {
  const p = resolve(config.dataDir, ...parts);
  if (!p.startsWith(resolve(config.dataDir) + sep)) throw badRequest('Chemin invalide');
  return p;
}

/** Enregistre un fichier téléversé sous DATA_DIR/<dossier>/ avec un nom aléatoire. */
export async function saveUpload(file: MultipartFile, folder: string, allowed: RegExp): Promise<{ path: string; size: number; filename: string; mime: string }> {
  if (!allowed.test(file.mimetype)) throw badRequest(`Type de fichier non accepté (${file.mimetype}).`);
  const dir = dataPath(folder);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ext = extname(file.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const name = `${randomToken(12)}${ext}`;
  const full = join(dir, name);
  await pipeline(file.file, createWriteStream(full));
  if (file.file.truncated) throw badRequest('Fichier trop volumineux (10 Mo maximum).');
  const { statSync } = await import('node:fs');
  return { path: `${folder}/${name}`, size: statSync(full).size, filename: file.filename.slice(0, 200), mime: file.mimetype };
}
