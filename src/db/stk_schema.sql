-- STK push (parent pays from the portal). Safe to run again and again.

-- Each school has its own passkey from Safaricom. Encrypted, same as the keys. Never shown on any screen.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS mpesa_passkey_enc TEXT;

-- One row per push request we send to a parent's phone.
CREATE TABLE IF NOT EXISTS stk_requests (
  id                   SERIAL PRIMARY KEY,
  school_id            INTEGER NOT NULL REFERENCES schools(id),
  student_id           INTEGER NOT NULL REFERENCES students(id),
  phone                TEXT NOT NULL,              -- the phone that gets the prompt, as 2547XXXXXXXX
  amount               NUMERIC NOT NULL CHECK (amount >= 1),
  account_ref          TEXT NOT NULL,              -- sent to Safaricom as the account (the admission number)
  merchant_request_id  TEXT,                       -- Safaricom's ids, filled when the request is accepted
  checkout_request_id  TEXT UNIQUE,                -- the callback and the status check find the row by this
  status               TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'sent', 'paid', 'cancelled', 'failed', 'timeout')),
  result_code          INTEGER,                    -- 0 = paid, 1032 = parent cancelled, others = failed
  result_desc          TEXT,
  mpesa_receipt        TEXT,                       -- e.g. SKR4T8W2QA, filled when paid
  callback_payload     JSONB,                      -- what Safaricom sent, kept for checking later
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stk_requests_school ON stk_requests (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stk_requests_student ON stk_requests (student_id, status);

-- Step 3: each push gets its own secret code inside its callback address. We keep only a fingerprint (hash) of it,
-- so even someone who reads the database cannot build a fake "paid" message.
ALTER TABLE stk_requests ADD COLUMN IF NOT EXISTS callback_token_hash TEXT;