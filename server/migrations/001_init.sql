-- Jadip Flow — schéma initial
-- Règle : aucune donnée métier des workflows n'est stockée, uniquement des métadonnées.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- clients
CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name            text NOT NULL,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  notes           text,
  logo_path       text,
  is_internal     boolean NOT NULL DEFAULT false,
  -- autorisations accordées au client dans son espace
  can_toggle      boolean NOT NULL DEFAULT true,
  can_retry       boolean NOT NULL DEFAULT false,
  show_costs      boolean NOT NULL DEFAULT false,
  show_reports    boolean NOT NULL DEFAULT true,
  report_email_enabled boolean NOT NULL DEFAULT false,
  report_emails   text[] NOT NULL DEFAULT '{}',
  -- finances
  monthly_budget_usd numeric(12,2),
  monthly_fee_usd    numeric(12,2),
  inactivity_days    integer NOT NULL DEFAULT 3,
  -- préparé pour la marque blanche et la facturation (non implémenté en v1)
  brand_name      text,
  brand_primary_color text,
  brand_logo_path text,
  billing_plan    text,
  billing_customer_ref text,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- utilisateurs
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','client')),
  client_id       uuid REFERENCES clients(id) ON DELETE CASCADE,
  password_hash   text,
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  telegram_chat_id text,
  notify_email    boolean NOT NULL DEFAULT true,
  notify_telegram boolean NOT NULL DEFAULT false,
  notify_on_error boolean NOT NULL DEFAULT true,
  notify_weekly_summary boolean NOT NULL DEFAULT false,
  disabled_at     timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'client') = (client_id IS NOT NULL))
);

CREATE TABLE user_tokens (
  -- invitations, réinitialisations de mot de passe
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,              -- sha256 du jeton de cookie
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_pending boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  prefix      text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{read}',
  last_used_at timestamptz,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- instances n8n
CREATE TABLE instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  base_url        text NOT NULL,
  public_url      text,                       -- URL pour les liens « ouvrir dans n8n »
  api_key_enc     text NOT NULL,
  sync_enabled    boolean NOT NULL DEFAULT true,
  sync_interval_minutes integer NOT NULL DEFAULT 5 CHECK (sync_interval_minutes BETWEEN 1 AND 1440),
  retention_days  integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  health_status   text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown','ok','degraded','down')),
  health_message  text,
  health_checked_at timestamptz,
  last_sync_at    timestamptz,
  last_sync_status text,
  executions_cursor_started_at timestamptz,   -- plus récente exécution terminée déjà importée
  consecutive_sync_failures integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id            bigserial PRIMARY KEY,
  instance_id   uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  trigger       text NOT NULL CHECK (trigger IN ('schedule','manual')),
  status        text NOT NULL CHECK (status IN ('running','success','error')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  workflows_seen integer,
  workflows_created integer,
  workflows_renamed integer,
  workflows_deleted integer,
  executions_imported integer,
  error_message text
);
CREATE INDEX sync_runs_instance ON sync_runs(instance_id, started_at DESC);

-- ---------------------------------------------------------------- workflows
CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  n8n_id          text NOT NULL,
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT false,
  tags            text[] NOT NULL DEFAULT '{}',
  n8n_updated_at  timestamptz,
  n8n_created_at  timestamptz,
  is_archived_in_n8n boolean NOT NULL DEFAULT false,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  client_assignment text NOT NULL DEFAULT 'none' CHECK (client_assignment IN ('none','tag','manual')),
  display_name    text,                       -- nom lisible pour le client
  description     text,                       -- description humaine rédigée par l'agence
  minutes_saved_per_execution numeric(8,2) NOT NULL DEFAULT 0,
  cost_per_execution_usd numeric(12,6) NOT NULL DEFAULT 0, -- estimation LLM si le fournisseur n'expose pas l'usage
  is_locked       boolean NOT NULL DEFAULT false,  -- critique : pas de désactivation depuis le portail
  client_visible  boolean NOT NULL DEFAULT true,
  client_can_toggle boolean NOT NULL DEFAULT true,
  client_can_retry boolean NOT NULL DEFAULT true,
  paused_until    timestamptz,                -- pause temporaire demandée depuis le portail
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  last_execution_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, n8n_id)
);
CREATE INDEX workflows_client ON workflows(client_id) WHERE deleted_at IS NULL;

CREATE TABLE workflow_events (
  id          bigserial PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind        text NOT NULL,   -- created, renamed, deleted, restored, activated, deactivated, assigned
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_events_wf ON workflow_events(workflow_id, created_at DESC);

-- ---------------------------------------------------------------- exécutions (métadonnées)
CREATE TABLE executions (
  id            bigserial PRIMARY KEY,
  instance_id   uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  workflow_id   uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE SET NULL,  -- dénormalisé pour le cloisonnement et la vitesse
  n8n_execution_id text NOT NULL,
  status        text NOT NULL,   -- success, error, crashed, canceled, running, waiting, new
  mode          text,
  started_at    timestamptz,
  stopped_at    timestamptz,
  duration_ms   integer,
  retry_of      text,
  retry_success_id text,
  error_node    text,
  error_message text,            -- tronqué, jamais les données traitées
  error_category text CHECK (error_category IN ('auth','rate_limit','network','data','logic')),
  handled_at    timestamptz,
  handled_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, n8n_execution_id)
);
CREATE INDEX executions_wf_started ON executions(workflow_id, started_at DESC, id DESC);
CREATE INDEX executions_client_started ON executions(client_id, started_at DESC, id DESC);
CREATE INDEX executions_started ON executions(started_at DESC, id DESC);
CREATE INDEX executions_errors ON executions(started_at DESC) WHERE status IN ('error','crashed');

-- ---------------------------------------------------------------- journal d'actions (métier)
CREATE TABLE action_log (
  id          bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role  text,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  action      text NOT NULL,
  result      text NOT NULL CHECK (result IN ('ok','error','refused')),
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_log_client ON action_log(client_id, created_at DESC);
CREATE INDEX action_log_wf ON action_log(workflow_id, created_at DESC);

-- ---------------------------------------------------------------- journal d'audit inaltérable
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid,
  actor_label text,
  source      text NOT NULL,       -- web, api, mcp, system
  action      text NOT NULL,
  target_type text,
  target_id   text,
  client_id   uuid,
  ip          text,
  detail      jsonb NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE INDEX audit_log_at ON audit_log(at DESC);

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(727274);
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, 'genesis');
  NEW.hash := encode(digest(
      NEW.prev_hash || '|' || (extract(epoch from NEW.at))::text || '|' || COALESCE(NEW.actor_user_id::text,'') || '|' ||
      COALESCE(NEW.actor_label,'') || '|' || NEW.source || '|' || NEW.action || '|' ||
      COALESCE(NEW.target_type,'') || '|' || COALESCE(NEW.target_id,'') || '|' ||
      COALESCE(NEW.client_id::text,'') || '|' || COALESCE(NEW.ip,'') || '|' || NEW.detail::text,
      'sha256'), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est inaltérable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------- alertes
CREATE TABLE alert_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('execution_failed','workflow_inactive','failure_rate','sync_failed','llm_budget')),
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,   -- NULL = global
  workflow_id   uuid REFERENCES workflows(id) ON DELETE CASCADE,
  threshold     numeric,        -- jours, %, nombre d'échecs de synchro, % du budget
  window_hours  integer NOT NULL DEFAULT 24,
  group_minutes integer NOT NULL DEFAULT 15,    -- regroupement anti-bruit
  repeat_minutes integer NOT NULL DEFAULT 240,  -- délai de répétition
  channels      text[] NOT NULL DEFAULT '{app,telegram}',
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id            bigserial PRIMARY KEY,
  rule_id       uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  dedup_key     text NOT NULL,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  workflow_id   uuid REFERENCES workflows(id) ON DELETE CASCADE,
  instance_id   uuid REFERENCES instances(id) ON DELETE CASCADE,
  severity      text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  title         text NOT NULL,
  message       text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notified_occurrences integer NOT NULL DEFAULT 0,
  resolved_at   timestamptz
);
CREATE UNIQUE INDEX alerts_open_dedup ON alerts(dedup_key) WHERE status <> 'resolved';
CREATE INDEX alerts_status ON alerts(status, last_seen_at DESC);

CREATE TABLE notifications (
  -- notifications dans l'application
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,  -- NULL = tous les administrateurs
  client_id   uuid REFERENCES clients(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE outbox (
  -- messages sortants (Telegram, e-mail), différés pendant les horaires calmes
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('telegram','email')),
  recipient   text NOT NULL,
  subject     text,
  body        text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  bypass_quiet boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  not_before  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(not_before) WHERE status = 'pending';

-- ---------------------------------------------------------------- paramètres
CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

-- ---------------------------------------------------------------- coûts LLM
CREATE TABLE llm_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','manual')),
  name        text NOT NULL,
  api_key_enc text,
  enabled     boolean NOT NULL DEFAULT true,
  last_fetch_at timestamptz,
  last_fetch_status text,
  last_fetch_message text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_attribution_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES llm_accounts(id) ON DELETE CASCADE,
  dimension   text NOT NULL CHECK (dimension IN ('project','api_key','workspace','model')),
  match_value text NOT NULL,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dimension, match_value)
);

CREATE TABLE llm_usage (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES llm_accounts(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('api','manual','estimate')),
  day         date NOT NULL,
  provider    text NOT NULL,
  model       text NOT NULL DEFAULT 'inconnu',
  project     text,
  api_key_ref text,
  workspace   text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd    numeric(14,6) NOT NULL DEFAULT 0,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  note        text,
  external_key text,       -- clé de déduplication pour les imports API
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX llm_usage_external ON llm_usage(account_id, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX llm_usage_client_day ON llm_usage(client_id, day);

CREATE TABLE llm_key_snapshots (
  -- OpenRouter : usage cumulé par clé, pour calculer les deltas quotidiens
  account_id  uuid NOT NULL REFERENCES llm_accounts(id) ON DELETE CASCADE,
  key_ref     text NOT NULL,
  day         date NOT NULL,
  cumulative_usd numeric(14,6) NOT NULL,
  PRIMARY KEY (account_id, key_ref, day)
);

-- ---------------------------------------------------------------- rapports
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  pdf_path    text,
  xlsx_path   text,
  summary     jsonb NOT NULL DEFAULT '{}',
  emailed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period)
);

-- ---------------------------------------------------------------- demandes (tickets)
CREATE TABLE tickets (
  id          bigserial PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('change','problem','question')),
  subject     text NOT NULL,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','waiting_client','done','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_client ON tickets(client_id, created_at DESC);

CREATE TABLE ticket_messages (
  id          bigserial PRIMARY KEY,
  ticket_id   bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  author_role text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id  bigint REFERENCES ticket_messages(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  storage_path text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- webhooks sortants
CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  url         text NOT NULL,
  secret_enc  text NOT NULL,
  events      text[] NOT NULL,
  client_id   uuid REFERENCES clients(id) ON DELETE CASCADE,  -- NULL = tous
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  response_code integer,
  last_error  text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- tâches planifiées
CREATE TABLE job_runs (
  name        text PRIMARY KEY,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text,
  last_message text
);
