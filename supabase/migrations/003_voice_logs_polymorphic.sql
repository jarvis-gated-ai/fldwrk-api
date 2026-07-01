-- Migration: 003_voice_logs_polymorphic
-- Make voice_logs linkable to any record type (not just jobs)
-- and persist unlinked voice recordings.

-- 1. Drop NOT NULL constraint on job_id (unlinked recordings now allowed)
ALTER TABLE voice_logs
  ALTER COLUMN job_id DROP NOT NULL;

-- 2. Add polymorphic link columns
ALTER TABLE voice_logs
  ADD COLUMN IF NOT EXISTS linked_to_type TEXT CHECK (linked_to_type IN ('job', 'customer', 'quote')),
  ADD COLUMN IF NOT EXISTS linked_to_id   UUID,
  ADD COLUMN IF NOT EXISTS actions_created JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3. Backfill: migrate existing job_id rows to polymorphic columns
UPDATE voice_logs
  SET linked_to_type = 'job',
      linked_to_id   = job_id
WHERE job_id IS NOT NULL
  AND linked_to_type IS NULL;

-- 4. Index for lookups by linked record
CREATE INDEX IF NOT EXISTS idx_voice_logs_linked
  ON voice_logs (linked_to_type, linked_to_id);

-- 5. RLS — existing policies on user_id cover isolation; nothing to change.
-- Confirm: "company members can view voice_logs" uses user_id join, still valid.
