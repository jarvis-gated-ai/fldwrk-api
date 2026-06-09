-- =============================================
--  FLDWRK — Support & Bug Case Management
--  Version: 002
-- =============================================

-- ─── ENUMS ───────────────────────────────────

CREATE TYPE support_status AS ENUM (
  'New',
  'Auto_Resolved',
  'Pending_Review',
  'Escalated',
  'Closed'
);

CREATE TYPE support_priority AS ENUM (
  'Low',
  'Medium',
  'High',
  'Critical'
);

CREATE TYPE support_category AS ENUM (
  'Bug',
  'Billing',
  'Account_Access',
  'Feature_Request',
  'General_Inquiry'
);

CREATE TYPE interaction_type AS ENUM (
  'user_message',
  'ai_response',
  'human_note',
  'status_change',
  'escalation'
);

-- ─── SUPPORT CASES ───────────────────────────

CREATE TABLE support_cases (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject              TEXT NOT NULL,
  description          TEXT NOT NULL,
  status               support_status NOT NULL DEFAULT 'New',
  priority             support_priority NOT NULL DEFAULT 'Medium',
  category             support_category,
  sub_category         TEXT,
  ai_confidence_score  FLOAT,
  escalated_to_human   BOOLEAN NOT NULL DEFAULT false,
  slack_thread_ts      TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── SUPPORT INTERACTIONS ────────────────────

CREATE TABLE support_interactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id       UUID NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  actor_type    interaction_type NOT NULL,
  actor_id      TEXT,
  content       TEXT NOT NULL,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────

CREATE INDEX idx_support_cases_user_id    ON support_cases(user_id);
CREATE INDEX idx_support_cases_company_id ON support_cases(company_id);
CREATE INDEX idx_support_cases_status     ON support_cases(status);
CREATE INDEX idx_support_cases_created_at ON support_cases(created_at);
CREATE INDEX idx_support_cases_category   ON support_cases(category);

CREATE INDEX idx_support_interactions_case_id ON support_interactions(case_id);

-- ─── TRIGGER: auto-update updated_at ─────────
-- The update_updated_at_column() function is already defined in 001_initial_schema.sql.
-- Using CREATE OR REPLACE here is safe for re-runs.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_support_cases_updated_at
  BEFORE UPDATE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── ROW LEVEL SECURITY ───────────────────────

ALTER TABLE support_cases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_interactions ENABLE ROW LEVEL SECURITY;

-- Users can view and create their own cases
CREATE POLICY "Users see own cases"
  ON support_cases FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users create own cases"
  ON support_cases FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Interactions are visible to the case owner
CREATE POLICY "Users see own case interactions"
  ON support_interactions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM support_cases sc
      WHERE sc.id = case_id
        AND sc.user_id = auth.uid()
    )
  );
