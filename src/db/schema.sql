-- Schools using the platform. Each school owns its own paybill / bank account.
CREATE TABLE IF NOT EXISTS schools (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mpesa_shortcode TEXT UNIQUE,
  mpesa_consumer_key_enc TEXT,      -- encrypted, never plain text
  mpesa_consumer_secret_enc TEXT,   -- encrypted, never plain text
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Students / fee payers for a school.
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  admission_no TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,               -- student's own registered phone, if any
  guardian_phone TEXT,      -- parent/guardian phone, usually the one that pays
  guardian_name TEXT,       -- parents often pay under their own name, not the student's
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_id, admission_no)
);

-- Every incoming payment, from whichever source, lands here first.
-- Nothing is deleted or overwritten - this is the source of truth ledger.
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  source TEXT NOT NULL,             -- 'mpesa' | 'equity' | 'kcb' | 'coop' | 'manual'
  external_ref TEXT,                -- e.g. M-Pesa receipt number, bank transaction id
  amount NUMERIC NOT NULL,
  payer_phone TEXT,
  payer_name TEXT,
  narration TEXT,                   -- free-text reference the payer typed/entered
  raw_payload JSONB,                -- full payload as received, kept for audit/debugging
  received_at TIMESTAMPTZ DEFAULT NOW(),

  match_status TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched | auto_matched | needs_review | confirmed | rejected
  matched_student_id INTEGER REFERENCES students(id),
  confidence NUMERIC,                -- 0..1, how sure the matcher was
  match_reason TEXT,                -- short human-readable explanation, shown in review queue
  candidates JSONB,                 -- when ambiguous (e.g. siblings sharing a phone), the short list to pick from

  UNIQUE(source, external_ref)      -- prevents double-processing the same webhook
);

CREATE INDEX IF NOT EXISTS idx_transactions_school_status
  ON transactions(school_id, match_status);

CREATE INDEX IF NOT EXISTS idx_students_school
  ON students(school_id);

-- The list of banks the platform supports. Adding a new bank later is just
-- a new row here, not a schema change or a new column on schools.
CREATE TABLE IF NOT EXISTS bank_providers (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,        -- 'equity' | 'kcb' | 'coop' | 'nbk'
  name TEXT NOT NULL,
  credential_fields JSONB NOT NULL
);

INSERT INTO bank_providers (code, name, credential_fields) VALUES
  ('equity', 'Equity Bank (Jenga API)', '["ipn_username", "ipn_password"]'),
  ('kcb',    'KCB Bank (Buni API)',     '["consumer_key", "consumer_secret", "account_number"]'),
  ('coop',   'Co-operative Bank',       '["api_key", "account_number"]'),
  ('nbk',    'National Bank of Kenya',  '["api_key", "account_number"]')
ON CONFLICT (code) DO NOTHING;

-- Which bank(s) a specific school has actually connected, with THEIR OWN
-- credentials for that bank - encrypted as one JSON blob.
CREATE TABLE IF NOT EXISTS school_bank_connections (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  provider_id INTEGER NOT NULL REFERENCES bank_providers(id),
  account_number TEXT,
  credentials_enc TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_id, provider_id)
);
