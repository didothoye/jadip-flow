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
