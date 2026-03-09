-- CreateSchema
-- Initial migration: creates all enums, tables, indexes, and constraints
-- for the NexusOps platform.

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

CREATE TYPE "TaskStatus" AS ENUM (
  'PENDING', 'QUEUED', 'RUNNING', 'PENDING_APPROVAL',
  'COMPLETED', 'FAILED', 'ESCALATED', 'CANCELLED'
);

CREATE TYPE "Provider" AS ENUM (
  'OPENAI', 'ANTHROPIC', 'GOOGLE', 'AWS_BEDROCK',
  'AZURE_OPENAI', 'MISTRAL', 'OLLAMA', 'ON_PREMISE', 'CUSTOM'
);

CREATE TYPE "AgentStatus" AS ENUM ('IDLE', 'ACTIVE', 'STALLED', 'ZOMBIE', 'TERMINATED');

CREATE TYPE "PolicyAction" AS ENUM ('ALLOW', 'DENY', 'ESCALATE_TO_HUMAN');

CREATE TYPE "ToolType" AS ENUM ('GITHUB', 'JIRA', 'CLOUD_DEPLOY', 'DATABASE', 'CUSTOM');

CREATE TYPE "Environment" AS ENUM ('DEVELOPMENT', 'STAGING', 'PRODUCTION');

CREATE TYPE "DataClassification" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');

-- ─── workspaces ──────────────────────────────────────────────────────────────

CREATE TABLE workspaces (
  id                        TEXT        NOT NULL,
  name                      TEXT        NOT NULL,
  slug                      TEXT        NOT NULL,
  financial_exposure_config  JSONB,
  data_region               TEXT,
  plan                      TEXT        NOT NULL DEFAULT 'free',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX workspaces_slug_key ON workspaces(slug);
CREATE INDEX workspaces_slug_idx ON workspaces(slug);

-- ─── users ───────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id             TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  name           TEXT,
  avatar_url     TEXT,
  email_verified BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL,
  last_login_at  TIMESTAMPTZ,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX users_email_key ON users(email);
CREATE INDEX users_email_idx ON users(email);

-- ─── workspace_invitations ───────────────────────────────────────────────────

CREATE TABLE workspace_invitations (
  id            TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  role          "UserRole"  NOT NULL DEFAULT 'VIEWER',
  token         TEXT        NOT NULL,
  invited_by_id TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX workspace_invitations_token_key ON workspace_invitations(token);
CREATE INDEX workspace_invitations_workspace_id_idx ON workspace_invitations(workspace_id);
CREATE INDEX workspace_invitations_token_idx ON workspace_invitations(token);
CREATE INDEX workspace_invitations_email_idx ON workspace_invitations(email);

-- ─── workspace_users ─────────────────────────────────────────────────────────

CREATE TABLE workspace_users (
  id           TEXT        NOT NULL,
  workspace_id TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         "UserRole"  NOT NULL DEFAULT 'VIEWER',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX workspace_users_workspace_id_user_id_key ON workspace_users(workspace_id, user_id);
CREATE INDEX workspace_users_workspace_id_idx ON workspace_users(workspace_id);
CREATE INDEX workspace_users_user_id_idx ON workspace_users(user_id);

-- ─── refresh_tokens ──────────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id          TEXT        NOT NULL,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  replaced_by TEXT,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX refresh_tokens_token_key ON refresh_tokens(token);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_token_idx ON refresh_tokens(token);

-- ─── api_keys ────────────────────────────────────────────────────────────────

CREATE TABLE api_keys (
  id           TEXT        NOT NULL,
  workspace_id TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  key_hash     TEXT        NOT NULL,
  key_prefix   TEXT        NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  rate_limit   INTEGER,
  scope        TEXT        NOT NULL DEFAULT 'full_access',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX api_keys_key_hash_key ON api_keys(key_hash);
CREATE INDEX api_keys_workspace_id_idx ON api_keys(workspace_id);
CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash);

-- ─── agents ──────────────────────────────────────────────────────────────────

CREATE TABLE agents (
  id                              TEXT           NOT NULL,
  workspace_id                    TEXT           NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                            TEXT           NOT NULL,
  description                     TEXT,
  public_key                      TEXT,
  version                         TEXT           NOT NULL,
  status                          "AgentStatus"  NOT NULL DEFAULT 'IDLE',
  config                          JSONB          NOT NULL,
  tool_permissions                TEXT[]         NOT NULL,
  max_tokens                      INTEGER,
  max_cost_usd                    DOUBLE PRECISION,
  max_execution_ms                INTEGER,
  max_depth                       INTEGER        NOT NULL DEFAULT 10,
  heartbeat_at                    TIMESTAMPTZ,
  blast_radius_score              DOUBLE PRECISION,
  blast_radius_max_damage_usd     DOUBLE PRECISION,
  blast_radius_governed_damage_usd DOUBLE PRECISION,
  blast_radius_last_calculated_at TIMESTAMPTZ,
  safety_schema                   JSONB,
  customer_database_url           TEXT,
  customer_database_config        JSONB,
  created_at                      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ    NOT NULL,
  terminated_at                   TIMESTAMPTZ,
  PRIMARY KEY (id)
);

CREATE INDEX agents_workspace_id_idx ON agents(workspace_id);
CREATE INDEX agents_status_idx ON agents(status);

-- ─── tasks ───────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id            TEXT           NOT NULL,
  workspace_id  TEXT           NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT           NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name          TEXT           NOT NULL,
  description   TEXT,
  status        "TaskStatus"   NOT NULL DEFAULT 'PENDING',
  trace_id      TEXT           NOT NULL,
  input         JSONB          NOT NULL,
  output        JSONB,
  error         JSONB,
  token_count   INTEGER        NOT NULL DEFAULT 0,
  cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX tasks_trace_id_key ON tasks(trace_id);
CREATE INDEX tasks_workspace_id_idx ON tasks(workspace_id);
CREATE INDEX tasks_agent_id_idx ON tasks(agent_id);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_created_at_idx ON tasks(created_at);
CREATE INDEX tasks_trace_id_idx ON tasks(trace_id);

-- ─── task_approvals ──────────────────────────────────────────────────────────

CREATE TABLE task_approvals (
  id                 TEXT             NOT NULL,
  task_id            TEXT             NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id            TEXT             REFERENCES users(id) ON DELETE SET NULL,
  approved           BOOLEAN          NOT NULL DEFAULT false,
  reason             TEXT,
  blast_radius_delta DOUBLE PRECISION,
  risk_score         DOUBLE PRECISION,
  timeout_at         TIMESTAMPTZ,
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX task_approvals_task_id_idx ON task_approvals(task_id);
CREATE INDEX task_approvals_timeout_at_idx ON task_approvals(timeout_at);

-- ─── tool_calls ──────────────────────────────────────────────────────────────

CREATE TABLE tool_calls (
  id              TEXT             NOT NULL,
  workspace_id    TEXT             NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id         TEXT             NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id        TEXT             NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_type       "ToolType"       NOT NULL,
  tool_method     TEXT             NOT NULL,
  provider        TEXT,
  input           JSONB            NOT NULL,
  output          JSONB,
  error           JSONB,
  blocked         BOOLEAN          NOT NULL DEFAULT false,
  block_reason    TEXT,
  model           TEXT,
  input_tokens    INTEGER          NOT NULL DEFAULT 0,
  output_tokens   INTEGER          NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  token_count     INTEGER          NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  policy_decision TEXT,
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX tool_calls_workspace_id_idx ON tool_calls(workspace_id);
CREATE INDEX tool_calls_task_id_idx ON tool_calls(task_id);
CREATE INDEX tool_calls_agent_id_idx ON tool_calls(agent_id);
CREATE INDEX tool_calls_tool_type_idx ON tool_calls(tool_type);
CREATE INDEX tool_calls_created_at_idx ON tool_calls(created_at);

-- ─── policy_rules ────────────────────────────────────────────────────────────

CREATE TABLE policy_rules (
  id           TEXT            NOT NULL,
  workspace_id TEXT            NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT            NOT NULL,
  description  TEXT,
  enabled      BOOLEAN         NOT NULL DEFAULT true,
  version      INTEGER         NOT NULL DEFAULT 1,
  action       "PolicyAction"  NOT NULL,
  priority     INTEGER         NOT NULL DEFAULT 0,
  conditions   JSONB           NOT NULL,
  created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ     NOT NULL,
  created_by   TEXT,
  PRIMARY KEY (id)
);

CREATE INDEX policy_rules_workspace_id_idx ON policy_rules(workspace_id);
CREATE INDEX policy_rules_enabled_idx ON policy_rules(enabled);
CREATE INDEX policy_rules_priority_idx ON policy_rules(priority);

-- ─── policy_evaluations ──────────────────────────────────────────────────────

CREATE TABLE policy_evaluations (
  id             TEXT            NOT NULL,
  policy_rule_id TEXT            NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  task_id        TEXT            NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  matched        BOOLEAN         NOT NULL,
  action         "PolicyAction"  NOT NULL,
  reason         TEXT,
  evaluation_ms  INTEGER         NOT NULL,
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX policy_evaluations_policy_rule_id_idx ON policy_evaluations(policy_rule_id);
CREATE INDEX policy_evaluations_task_id_idx ON policy_evaluations(task_id);
CREATE INDEX policy_evaluations_created_at_idx ON policy_evaluations(created_at);

-- ─── budgets ─────────────────────────────────────────────────────────────────

CREATE TABLE budgets (
  id                           TEXT             NOT NULL,
  workspace_id                 TEXT             NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id                     TEXT             REFERENCES agents(id) ON DELETE CASCADE,
  max_tokens                   INTEGER,
  max_cost_usd                 DOUBLE PRECISION,
  velocity_limit_usd_per_minute DOUBLE PRECISION,
  workspace_daily_limit_usd    DOUBLE PRECISION,
  period_start                 TIMESTAMPTZ      NOT NULL,
  period_end                   TIMESTAMPTZ      NOT NULL,
  current_tokens               INTEGER          NOT NULL DEFAULT 0,
  current_cost_usd             DOUBLE PRECISION NOT NULL DEFAULT 0,
  alert_threshold              DOUBLE PRECISION,
  auto_halt                    BOOLEAN          NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ      NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX budgets_workspace_id_idx ON budgets(workspace_id);
CREATE INDEX budgets_agent_id_idx ON budgets(agent_id);

-- ─── audit_events ────────────────────────────────────────────────────────────

CREATE TABLE audit_events (
  id              TEXT        NOT NULL,
  workspace_id    TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         TEXT        REFERENCES users(id) ON DELETE SET NULL,
  event_type      TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,
  entity_id       TEXT,
  action          TEXT        NOT NULL,
  metadata        JSONB       NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  content_hash    TEXT,
  previous_hash   TEXT,
  chain_index     INTEGER     NOT NULL DEFAULT 0,
  agent_signature TEXT,
  provider        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX audit_events_workspace_id_idx ON audit_events(workspace_id);
CREATE INDEX audit_events_user_id_idx ON audit_events(user_id);
CREATE INDEX audit_events_event_type_idx ON audit_events(event_type);
CREATE INDEX audit_events_created_at_idx ON audit_events(created_at);
CREATE INDEX audit_events_chain_index_idx ON audit_events(chain_index);

-- ─── metrics ─────────────────────────────────────────────────────────────────

CREATE TABLE metrics (
  id           TEXT             NOT NULL,
  workspace_id TEXT             NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT,
  metric_name  TEXT             NOT NULL,
  value        DOUBLE PRECISION NOT NULL,
  tags         JSONB,
  timestamp    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX metrics_workspace_id_idx ON metrics(workspace_id);
CREATE INDEX metrics_metric_name_idx ON metrics(metric_name);
CREATE INDEX metrics_timestamp_idx ON metrics(timestamp);
CREATE INDEX metrics_workspace_id_metric_name_timestamp_idx ON metrics(workspace_id, metric_name, timestamp);

-- ─── compliance_artifacts ────────────────────────────────────────────────────

CREATE TABLE compliance_artifacts (
  id                           TEXT                  NOT NULL,
  workspace_id                 TEXT                  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id                      TEXT                  NOT NULL,
  agent_id                     TEXT                  NOT NULL,
  user_prompt                  TEXT                  NOT NULL,
  submitted_by_user_id         TEXT,
  submitted_at                 TIMESTAMPTZ           NOT NULL,
  reasoning_chain              JSONB,
  reasoning_captured_at        TIMESTAMPTZ,
  context_refs                 JSONB,
  policy_decision              "PolicyAction"        NOT NULL,
  policy_rule_id               TEXT,
  policy_version               INTEGER               NOT NULL DEFAULT 1,
  policy_input_hash            TEXT,
  tool_call_id                 TEXT,
  request_payload_hash         TEXT,
  response_payload_hash        TEXT,
  execution_duration_ms        INTEGER,
  cost_usd                     DOUBLE PRECISION      NOT NULL DEFAULT 0,
  data_classification_touched  "DataClassification"  NOT NULL DEFAULT 'PUBLIC',
  provider                     TEXT,
  content_hash                 TEXT                  NOT NULL,
  previous_hash                TEXT,
  chain_index                  INTEGER               NOT NULL DEFAULT 0,
  agent_signature              TEXT,
  timestamp_authority          TEXT,
  anchor_tx_hash               TEXT,
  anchor_block_number          BIGINT,
  created_at                   TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX compliance_artifacts_workspace_id_idx ON compliance_artifacts(workspace_id);
CREATE INDEX compliance_artifacts_task_id_idx ON compliance_artifacts(task_id);
CREATE INDEX compliance_artifacts_agent_id_idx ON compliance_artifacts(agent_id);
CREATE INDEX compliance_artifacts_chain_index_idx ON compliance_artifacts(chain_index);
CREATE INDEX compliance_artifacts_created_at_idx ON compliance_artifacts(created_at);
CREATE INDEX compliance_artifacts_content_hash_idx ON compliance_artifacts(content_hash);

-- ─── agent_memory_entries ────────────────────────────────────────────────────

CREATE TABLE agent_memory_entries (
  id                  TEXT                  NOT NULL,
  workspace_id        TEXT                  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            TEXT                  NOT NULL,
  key                 TEXT                  NOT NULL,
  value               JSONB                NOT NULL,
  data_classification "DataClassification"  NOT NULL DEFAULT 'PUBLIC',
  retention_days      INTEGER,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ           NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX agent_memory_entries_workspace_id_idx ON agent_memory_entries(workspace_id);
CREATE INDEX agent_memory_entries_agent_id_idx ON agent_memory_entries(agent_id);
CREATE INDEX agent_memory_entries_data_classification_idx ON agent_memory_entries(data_classification);
CREATE INDEX agent_memory_entries_expires_at_idx ON agent_memory_entries(expires_at);

-- ─── behavioural_baselines ───────────────────────────────────────────────────

CREATE TABLE behavioural_baselines (
  id              TEXT             NOT NULL,
  workspace_id    TEXT             NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id        TEXT             NOT NULL,
  dimensions      JSONB            NOT NULL,
  sample_count    INTEGER          NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  drift_threshold DOUBLE PRECISION NOT NULL DEFAULT 2.0,
  model_version   TEXT             NOT NULL DEFAULT 'v1',
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX behavioural_baselines_workspace_id_agent_id_key ON behavioural_baselines(workspace_id, agent_id);
CREATE INDEX behavioural_baselines_workspace_id_idx ON behavioural_baselines(workspace_id);
CREATE INDEX behavioural_baselines_agent_id_idx ON behavioural_baselines(agent_id);
