-- AddOAuthAccountsTable
-- LOW-5: SSO/OIDC support — add oauth_accounts table and make users.password_hash nullable
-- so that OIDC-only users can exist without a local password.

-- ─── Make password_hash nullable for OAuth users ─────────────────────────────
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ─── oauth_accounts ──────────────────────────────────────────────────────────
-- Links a NexusOps user to one or more OAuth2/OIDC provider identities.
-- A user may have multiple entries (e.g., Google and GitHub).
CREATE TABLE oauth_accounts (
  id                   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  user_id              TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT        NOT NULL,  -- 'google' | 'github' | 'microsoft'
  provider_account_id  TEXT        NOT NULL,  -- 'sub' claim from OIDC ID token
  email                TEXT,                  -- Email reported by provider
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX oauth_accounts_user_id ON oauth_accounts(user_id);

-- Auto-update updated_at on row mutation
CREATE OR REPLACE FUNCTION set_oauth_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oauth_accounts_updated_at
BEFORE UPDATE ON oauth_accounts
FOR EACH ROW EXECUTE FUNCTION set_oauth_accounts_updated_at();
