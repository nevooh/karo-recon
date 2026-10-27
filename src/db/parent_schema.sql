-- Parent portal. Safe to run again and again. Runs AFTER stk_schema.sql (it adds a column to stk_requests).

-- A parent is not a row in "students" or "staff": a parent IS a phone number that appears as a contact of one or
-- more students. This table only exists so "sign out everywhere" has something to bump (token_version).
CREATE TABLE IF NOT EXISTS parent_accounts (
  phone          TEXT PRIMARY KEY,                    -- 2547XXXXXXXX
  token_version  INTEGER NOT NULL DEFAULT 0,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per sign-in code asked for. We keep only a fingerprint of the code (never the code itself).
-- A row is written for EVERY request, even for a phone no school knows, so the "3 codes an hour" limit
-- behaves the same for every number and never shows which numbers are registered (those rows have used_at set).
CREATE TABLE IF NOT EXISTS parent_otps (
  id          SERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parent_otps_phone ON parent_otps (phone, id DESC);

-- Phones are saved as people typed them ("0712 345 678", "+254712345678"), so the portal compares the LAST 9 DIGITS.
-- These two indexes make that lookup fast.
CREATE INDEX IF NOT EXISTS idx_student_contacts_phone9
  ON student_contacts (right(regexp_replace(phone, '\D', '', 'g'), 9));
CREATE INDEX IF NOT EXISTS idx_students_guardian_phone9
  ON students (right(regexp_replace(guardian_phone, '\D', '', 'g'), 9));

-- When we last asked Safaricom "what happened to this push?" (so a polling portal does not hammer Safaricom).
ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
