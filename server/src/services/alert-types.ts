/**
 * Inventaire des types d'alertes et de notifications adressées à l'agence.
 *  - « critical » : vraie panne, envoyée sur Telegram par défaut ;
 *  - « info » : visible dans le portail, Telegram désactivé par défaut (activable dans Paramètres › Alertes Telegram).
 */
export interface AlertType { kind: string; label: string; description: string; level: 'critical' | 'info'; telegramDefault: boolean }

export const ALERT_TYPES: readonly AlertType[] = [
  { kind: 'execution_failed', label: 'Échec d’exécution d’un workflow', level: 'critical', telegramDefault: true,
    description: 'Une exécution se termine en erreur. Les échecs successifs d’un même workflow sont regroupés en un seul message.' },
  { kind: 'sync_failed', label: 'Instance n8n injoignable', level: 'critical', telegramDefault: true,
    description: 'La synchronisation échoue plusieurs fois de suite : l’instance ne répond plus ou refuse la clé API.' },
  { kind: 'failure_rate', label: 'Taux d’échec élevé', level: 'info', telegramDefault: false,
    description: 'Proportion d’échecs anormale sur la fenêtre d’observation (chaque échec fait déjà l’objet d’une alerte critique).' },
  { kind: 'llm_budget', label: 'Budget IA atteint', level: 'info', telegramDefault: false,
    description: 'La consommation IA d’un client approche ou dépasse son budget mensuel.' },
  { kind: 'ticket_created', label: 'Nouvelle demande d’un client', level: 'info', telegramDefault: false,
    description: 'Un client ouvre une demande (modification, problème, question) depuis son portail.' },
  { kind: 'ticket_reply', label: 'Réponse d’un client à une demande', level: 'info', telegramDefault: false,
    description: 'Un client répond dans une demande existante.' },
  { kind: 'client_action', label: 'Action d’un client sur une automatisation', level: 'info', telegramDefault: false,
    description: 'Un client active, désactive, met en pause ou relance une automatisation (si l’option « Me prévenir » est cochée).' },
];

export const ALERT_KINDS = ALERT_TYPES.map((t) => t.kind);
export type AlertKind = (typeof ALERT_TYPES)[number]['kind'];

export const defaultTelegramAlerts = (): Record<string, boolean> =>
  Object.fromEntries(ALERT_TYPES.map((t) => [t.kind, t.telegramDefault]));
