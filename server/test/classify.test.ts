import { describe, expect, it } from 'vitest';
import { classifyError, looksLikeCode, sanitizeErrorMessage } from '../src/services/classify.js';

/** Fiche 4 — un message d'erreur qui est en réalité du code (prélude de l'exécuteur n8n) est remplacé par une explication lisible. */
const PRELUDE = `{} }; Object.getPrototypeOf = () => ({}); Reflect.getPrototypeOf = () => ({}); Object.setPrototypeOf = () => false; Reflect.setPrototypeOf = () => false; delete Error.prepareStackTrace; delete Error.captureStackTrace; Object.defineProperty(Error, "prepareStackTrace", { configurable: false, writable: false, value: undefined }); Object.defineProperty(Error, "captureStackTrace", { configurable: false, writable: false, value: undefined });`;

describe('Messages d’erreur illisibles', () => {
  it('reconnaît le prélude de l’exécuteur n8n comme du code', () => {
    expect(looksLikeCode(PRELUDE)).toBe(true);
    expect(looksLikeCode('{} }; Object.getPrototypeOf = () => ({});')).toBe(true);
  });

  it('laisse intacts les messages normaux, même techniques ou en JSON', () => {
    for (const m of [
      "Cannot read properties of undefined (reading 'telephone')",
      'The service is receiving too many requests from you — Quota exceeded for quota metric \'Read requests\' and limit \'Read requests per minute per user\'',
      'permission denied for table contacts — Authentication',
      '{"error":{"code":429,"message":"Rate limit"}}',
      'connect ETIMEDOUT 102.68.12.4:443',
      'Workflow stopped: aucune règle ne correspond au statut reçu',
      'Bad request - please check your parameters',
    ]) {
      expect(looksLikeCode(m), m).toBe(false);
      expect(sanitizeErrorMessage(m, 'X')).toEqual({ message: m, category: classifyError(m), garbled: false });
    }
  });

  it('remplace le code par une explication, en gardant un court extrait et en classant « logique »', () => {
    const r = sanitizeErrorMessage(PRELUDE, 'Textes');
    expect(r.garbled).toBe(true);
    expect(r.category).toBe('logic');
    expect(r.message).toMatch(/^Erreur dans le nœud « Textes » : message technique illisible renvoyé par n8n \(extrait : « \{\} \}; Object\.getPrototypeOf/);
    expect(r.message.length).toBeLessThan(260);
    expect(r.message).not.toContain('defineProperty');
  });
});
