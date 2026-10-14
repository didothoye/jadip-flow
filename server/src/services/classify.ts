export type ErrorCategory = 'auth' | 'rate_limit' | 'network' | 'data' | 'logic';

const rules: [ErrorCategory, RegExp][] = [
  ['rate_limit', /\b429\b|rate.?limit|too many requests|quota|throttl|limite de débit|resource.?exhausted|overloaded/i],
  ['auth', /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (api )?key|api key|credential|authenticat|token (has )?expired|invalid[_ ]grant|permission denied|access denied|not authori[sz]ed/i],
  ['network', /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|timed? ?out|timeout|\b50[234]\b|bad gateway|service unavailable|network|getaddrinfo|certificate|ssl|tls/i],
  ['data', /json|parse|unexpected token|undefined|null|cannot read propert|is not a function|invalid (input|value|date|format)|validation|required|missing|expected|schema|type ?error|NaN|no (items|data)|\b400\b|\b422\b/i],
];

export function classifyError(message: string | null | undefined): ErrorCategory | null {
  if (!message) return null;
  for (const [cat, re] of rules) if (re.test(message)) return cat;
  return 'logic';
}

/** Indices qu'un texte est du code JavaScript plutôt qu'un message d'erreur. */
const CODE_SIGNS: RegExp[] = [
  /=>/, /Object\.(defineProperty|getPrototypeOf|setPrototypeOf|freeze)/, /\bReflect\.\w+/, /\bdelete\s+\w+\.\w+/,
  /\bfunction\s*\w*\s*\(/, /\b(const|let|var)\s+\w+\s*=/, /[{;}]\s*[{;}]/, /\bprepareStackTrace\b|\bcaptureStackTrace\b/,
];

/** Vrai si le message ressemble à du code (n8n 2.x renvoie parfois le prélude de son exécuteur JavaScript quand un nœud Code échoue). */
export function looksLikeCode(message: string): boolean {
  const hits = CODE_SIGNS.filter((re) => re.test(message)).length;
  return hits >= 3 || (hits >= 2 && message.length > 300);
}

/**
 * Message d'erreur présentable : un message illisible (code) est remplacé par une explication, un court extrait brut étant conservé pour le diagnostic.
 * `garbled` = vrai si le message a été remplacé ; il est alors classé « logique » sans passer par les mots-clés.
 */
export function sanitizeErrorMessage(raw: string, node: string | null): { message: string; category: ErrorCategory; garbled: boolean } {
  const message = raw.trim();
  if (!looksLikeCode(message)) return { message, category: classifyError(message) ?? 'logic', garbled: false };
  const excerpt = message.replace(/\s+/g, ' ').slice(0, 80);
  return {
    message: `Erreur dans le nœud « ${node ?? 'Code'} » : message technique illisible renvoyé par n8n (extrait : « ${excerpt}… »). Consultez l’exécution dans n8n.`,
    category: 'logic', garbled: true,
  };
}

export const categoryLabels: Record<ErrorCategory, string> = {
  auth: 'Authentification',
  rate_limit: 'Limite de débit',
  network: 'Réseau',
  data: 'Données',
  logic: 'Logique',
};

/** Explication en français simple, destinée au client. */
export const clientExplanations: Record<ErrorCategory, string> = {
  auth: 'Un service connecté a refusé l’accès (mot de passe ou autorisation expirés). Nous devons renouveler la connexion.',
  rate_limit: 'Un service a reçu trop de demandes en peu de temps et a demandé de patienter. Cela se règle généralement tout seul.',
  network: 'Un service extérieur n’a pas répondu à temps. C’est souvent passager : une nouvelle tentative suffit en général.',
  data: 'Les informations reçues n’avaient pas le format attendu (champ manquant ou inhabituel).',
  logic: 'L’automatisation a rencontré une situation imprévue. Notre équipe regarde ce qui s’est passé.',
};
