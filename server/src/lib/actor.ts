export interface Actor {
  userId: string;
  role: 'admin' | 'client';
  clientId: string | null;
  label: string;           // e-mail de l'utilisateur
  source: 'web' | 'api' | 'mcp' | 'system';
  ip?: string | null;
  scopes?: string[];       // jetons d'API
}

export const systemActor: Actor = { userId: '', role: 'admin', clientId: null, label: 'système', source: 'system' };
