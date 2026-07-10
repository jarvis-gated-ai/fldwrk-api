-- Migration 004: Build 76 schema additions
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_consent_at           timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url       text;

CREATE TABLE IF NOT EXISTS job_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  voice_log_id uuid REFERENCES voice_logs(id) ON DELETE SET NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  summary         text,
  work_performed  text,
  materials_used  text,
  issues_found    text,
  follow_ups      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_notes_job_id     ON job_notes(job_id);
CREATE INDEX IF NOT EXISTS idx_job_notes_company_id ON job_notes(company_id);
ALTER TABLE job_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "job_notes: company members read"   ON job_notes FOR SELECT USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));
CREATE POLICY IF NOT EXISTS "job_notes: company members insert" ON job_notes FOR INSERT WITH CHECK (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));
CREATE POLICY IF NOT EXISTS "job_notes: company members update" ON job_notes FOR UPDATE USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));
CREATE POLICY IF NOT EXISTS "job_notes: owner delete"           ON job_notes FOR DELETE USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS kb_articles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  category   text NOT NULL,
  title      text NOT NULL,
  summary    text NOT NULL,
  body       text NOT NULL,
  sort_order int  NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_articles_category   ON kb_articles(category);
CREATE INDEX IF NOT EXISTS idx_kb_articles_fts ON kb_articles USING gin(to_tsvector('english', title || ' ' || summary || ' ' || body));
ALTER TABLE kb_articles ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "kb_articles: public read" ON kb_articles FOR SELECT USING (true);

ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS request_category text CHECK (request_category IN ('bug', 'question', 'email-change', 'other'));
