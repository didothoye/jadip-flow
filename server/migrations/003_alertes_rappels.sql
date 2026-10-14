-- Fiche 1 : rappels d'alerte bornés, expiration des alertes d'échec sans nouvelle occurrence, motif de résolution.

-- 1. Plafond de rappels par règle (0 = aucun rappel ; la première notification et les regroupements ne sont pas concernés).
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS max_reminders int NOT NULL DEFAULT 3 CHECK (max_reminders >= 0);

-- 2. Suivi par alerte : rappels déjà envoyés, motif de résolution (reprise, expirée, workflow arrêté, retour à la normale, manuelle).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS reminders_sent int NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_reason text;

-- 3. Alertes d'échec ouvertes sans nouvelle occurrence depuis la fenêtre de leur règle : expirées.
--    L'historique est conservé ; un nouvel échec du même workflow ouvrira une alerte neuve.
UPDATE alerts a SET status = 'resolved', resolved_at = now(), resolved_reason = 'expirée'
FROM alert_rules r
WHERE r.id = a.rule_id AND a.kind = 'execution_failed' AND a.status <> 'resolved'
  AND a.last_seen_at < now() - (r.window_hours * interval '1 hour');
