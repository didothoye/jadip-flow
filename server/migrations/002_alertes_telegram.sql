-- Alertes Telegram : fin des alertes d'inactivité, compte Telegram et interrupteurs par type stockés en base.

-- 1. L'inactivité d'un workflow n'est plus un incident : règles supprimées, alertes ouvertes clôturées (l'historique est conservé).
DELETE FROM alert_rules WHERE kind = 'workflow_inactive';
UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE kind = 'workflow_inactive' AND status <> 'resolved';
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_kind_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_check CHECK (kind IN ('execution_failed','failure_rate','sync_failed','llm_budget'));

-- 2. Les échecs d'exécution sont des alertes critiques (envoi Telegram immédiat, hors heures calmes).
UPDATE alerts SET severity = 'critical' WHERE kind = 'execution_failed' AND status <> 'resolved';

-- 3. Interrupteurs Telegram par type d'alerte (les critiques activées, les informations désactivées).
--    Les clés « telegram_channel » (compte, jeton chiffré) sont créées par l'application au démarrage à partir du .env si présent.
INSERT INTO settings(key, value) VALUES ('telegramAlerts', '{
  "execution_failed": true, "sync_failed": true,
  "failure_rate": false, "llm_budget": false,
  "ticket_created": false, "ticket_reply": false, "client_action": false
}'::jsonb) ON CONFLICT (key) DO NOTHING;
