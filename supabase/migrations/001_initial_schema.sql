-- =============================================
--  TradePilot — Initial Schema Migration
--  Version: 001
-- =============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ─── ENUMS ───────────────────────────────────

CREATE TYPE plan_tier AS ENUM ('free', 'starter', 'pro', 'enterprise');
CREATE TYPE job_status AS ENUM ('pending', 'scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing', 'incomplete');
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'tech', 'viewer');

-- ─── COMPANIES ───────────────────────────────

CREATE TABLE companies (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  stripe_customer_id  TEXT UNIQUE,
  plan_tier           plan_tier NOT NULL DEFAULT 'free',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── USERS ───────────────────────────────────
-- Extends Supabase auth.users via id FK

CREATE TABLE users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  role        user_role NOT NULL DEFAULT 'tech',
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CUSTOMERS ───────────────────────────────

CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── JOBS ────────────────────────────────────

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  status        job_status NOT NULL DEFAULT 'pending',
  scheduled_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── VOICE LOGS ──────────────────────────────

CREATE TABLE voice_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  audio_url   TEXT,
  transcript  TEXT,
  summary     TEXT,
  -- pgvector embedding for semantic search (optional Phase 2)
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── QUOTES ──────────────────────────────────

CREATE TABLE quotes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  line_items  JSONB NOT NULL DEFAULT '[]',
  total_cents INTEGER NOT NULL DEFAULT 0,
  status      quote_status NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── SUBSCRIPTIONS ───────────────────────────

CREATE TABLE subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  plan_tier               plan_tier NOT NULL,
  status                  subscription_status NOT NULL DEFAULT 'trialing',
  current_period_end      TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────

-- Users
CREATE INDEX idx_users_company_id ON users(company_id);
CREATE INDEX idx_users_email ON users(email);

-- Customers
CREATE INDEX idx_customers_company_id ON customers(company_id);
CREATE INDEX idx_customers_name ON customers(name);

-- Jobs
CREATE INDEX idx_jobs_company_id ON jobs(company_id);
CREATE INDEX idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at);

-- Voice Logs
CREATE INDEX idx_voice_logs_job_id ON voice_logs(job_id);
CREATE INDEX idx_voice_logs_user_id ON voice_logs(user_id);

-- Quotes
CREATE INDEX idx_quotes_job_id ON quotes(job_id);
CREATE INDEX idx_quotes_status ON quotes(status);

-- Subscriptions
CREATE INDEX idx_subscriptions_company_id ON subscriptions(company_id);
CREATE INDEX idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id);

-- ─── ROW LEVEL SECURITY ───────────────────────
-- Companies can only see their own data.
-- All policies rely on a helper function that
-- resolves the current user's company_id.

-- Enable RLS on all tables
ALTER TABLE companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;

-- Helper: get company_id for the current auth user
CREATE OR REPLACE FUNCTION current_company_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT company_id FROM users WHERE id = auth.uid();
$$;

-- Helper: get role for the current auth user
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM users WHERE id = auth.uid();
$$;

-- ── companies ──

CREATE POLICY "users can view own company"
  ON companies FOR SELECT
  USING (id = current_company_id());

CREATE POLICY "owners can update own company"
  ON companies FOR UPDATE
  USING (id = current_company_id() AND current_user_role() IN ('owner', 'admin'));

-- ── users ──

CREATE POLICY "users can view teammates"
  ON users FOR SELECT
  USING (company_id = current_company_id());

CREATE POLICY "owners can insert users"
  ON users FOR INSERT
  WITH CHECK (company_id = current_company_id() AND current_user_role() IN ('owner', 'admin'));

CREATE POLICY "owners can update users"
  ON users FOR UPDATE
  USING (company_id = current_company_id() AND current_user_role() IN ('owner', 'admin'));

-- ── customers ──

CREATE POLICY "company members can view customers"
  ON customers FOR SELECT
  USING (company_id = current_company_id());

CREATE POLICY "company members can insert customers"
  ON customers FOR INSERT
  WITH CHECK (company_id = current_company_id());

CREATE POLICY "company members can update customers"
  ON customers FOR UPDATE
  USING (company_id = current_company_id());

CREATE POLICY "owners can delete customers"
  ON customers FOR DELETE
  USING (company_id = current_company_id() AND current_user_role() IN ('owner', 'admin'));

-- ── jobs ──

CREATE POLICY "company members can view jobs"
  ON jobs FOR SELECT
  USING (company_id = current_company_id());

CREATE POLICY "company members can insert jobs"
  ON jobs FOR INSERT
  WITH CHECK (company_id = current_company_id());

CREATE POLICY "company members can update jobs"
  ON jobs FOR UPDATE
  USING (company_id = current_company_id());

CREATE POLICY "owners can delete jobs"
  ON jobs FOR DELETE
  USING (company_id = current_company_id() AND current_user_role() IN ('owner', 'admin'));

-- ── voice_logs ──

CREATE POLICY "company members can view voice_logs"
  ON voice_logs FOR SELECT
  USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = current_company_id())
  );

CREATE POLICY "company members can insert voice_logs"
  ON voice_logs FOR INSERT
  WITH CHECK (
    job_id IN (SELECT id FROM jobs WHERE company_id = current_company_id())
  );

-- ── quotes ──

CREATE POLICY "company members can view quotes"
  ON quotes FOR SELECT
  USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = current_company_id())
  );

CREATE POLICY "company members can insert quotes"
  ON quotes FOR INSERT
  WITH CHECK (
    job_id IN (SELECT id FROM jobs WHERE company_id = current_company_id())
  );

CREATE POLICY "company members can update quotes"
  ON quotes FOR UPDATE
  USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = current_company_id())
  );

-- ── subscriptions ──

CREATE POLICY "company members can view subscriptions"
  ON subscriptions FOR SELECT
  USING (company_id = current_company_id());

-- ─── TRIGGERS: updated_at ─────────────────────
-- Auto-maintain updated_at columns if added later.
-- Keeping as a utility function for future use.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
