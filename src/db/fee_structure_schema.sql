-- ============================================================
-- ACADEMIC STRUCTURE
-- ============================================================

CREATE TABLE IF NOT EXISTS academic_years (
  id SERIAL PRIMARY KEY,
  year INTEGER UNIQUE NOT NULL,        -- e.g. 2026
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS terms (
  id SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  term_number SMALLINT NOT NULL CHECK (term_number IN (1, 2, 3)),
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(academic_year_id, term_number)
);

-- Now that terms exists, link payments to the term they landed in.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS term_id INTEGER REFERENCES terms(id);

-- ============================================================
-- CLASSES & STREAMS
-- ============================================================

CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,        -- 'Grade 1', 'Grade 2', ...
  sort_order INTEGER NOT NULL       -- defines "next class" ordering for promotion
);

-- The standard Kenyan class sequence, seeded once. A school doesn't type
-- these in - they just pick which ones they actually run. Playgroup isn't
-- part of the official government CBC structure but is common enough in
-- private schools to include as an optional starting point before PP1.
INSERT INTO classes (name, sort_order) VALUES
  ('Playgroup', 0),
  ('PP1', 1), ('PP2', 2),
  ('Grade 1', 3), ('Grade 2', 4), ('Grade 3', 5),
  ('Grade 4', 6), ('Grade 5', 7), ('Grade 6', 8),
  ('Grade 7', 9), ('Grade 8', 10), ('Grade 9', 11),
  ('Grade 10', 12), ('Grade 11', 13), ('Grade 12', 14)
ON CONFLICT (name) DO NOTHING;

-- A stream belongs to a SPECIFIC SCHOOL and a SPECIFIC ACADEMIC YEAR, not
-- permanently to a class. This matters: a stream is really a cohort of
-- kids moving together - "Grade 2's streams" this year are just whichever
-- streams last year's Grade 1 cohort happened to have. A fresh row gets
-- created every year as a cohort moves up; old rows are never reused or
-- repointed to a new class, since that would silently corrupt history
-- that references them (student_class_history stores a stream_id snapshot -
-- if that row's meaning changed later, old history would misreport itself).
CREATE TABLE IF NOT EXISTS streams (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  name TEXT NOT NULL,               -- 'North', 'South', 'Red', 'Yellow'...
  UNIQUE(school_id, class_id, academic_year_id, name)
);

-- OPTIONAL overrides to the default promotion behavior, per school.
-- Default (no row needed): a student's stream name just follows them to
-- the next class, recreated fresh under the new year. A row here is only
-- needed when a school wants something OTHER than that default - merging
-- two streams into one, renaming a stream on promotion, splitting one
-- stream into two, or the entry class where nothing precedes it.
-- Stream identity here is a NAME (text), not a foreign key to a specific
-- streams row - because that row won't exist yet for the destination year.
CREATE TABLE IF NOT EXISTS promotion_mappings (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  from_class_id INTEGER NOT NULL REFERENCES classes(id),
  from_stream_name TEXT,            -- NULL = applies to students with no stream
  to_class_id INTEGER NOT NULL REFERENCES classes(id),
  to_stream_name TEXT,              -- NULL = they arrive with no stream
  UNIQUE(school_id, from_class_id, from_stream_name)
);

-- Every student's CURRENT class/stream (this is the live pointer).
ALTER TABLE students ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES classes(id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS stream_id INTEGER REFERENCES streams(id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
-- status: 'active' | 'repeating' | 'transferred_out' | 'graduated'
-- Never delete a student row when they leave - the row (and their payment
-- history) stays, just marked. This is what keeps history queryable.

-- Append-only history: one row per student per academic year, NEVER
-- overwritten or deleted. This is what makes "what class was this kid in
-- during 2025" answerable forever, even after multiple promotions.
CREATE TABLE IF NOT EXISTS student_class_history (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  stream_id INTEGER REFERENCES streams(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, academic_year_id)
);

-- ============================================================
-- FEE STRUCTURE
-- ============================================================

-- What's charged, per term, per SCHOOL. Two schools' "Grade 1 Tuition"
-- must never collide or be visible to each other.
-- class_id NULL = applies to every class; set = only that specific class.
CREATE TABLE IF NOT EXISTS fee_items (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  class_id INTEGER REFERENCES classes(id),
  name TEXT NOT NULL,                -- 'Tuition', 'Transport', 'Lunch'
  amount NUMERIC NOT NULL,
  is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1
);

-- Whenever a class's fees are edited, the old rows land here first, before
-- being replaced - nothing is ever truly lost, just superseded.
CREATE TABLE IF NOT EXISTS fee_item_history (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  class_id INTEGER REFERENCES classes(id),
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  is_mandatory BOOLEAN NOT NULL,
  version INTEGER NOT NULL,
  replaced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mandatory fees need no entry here - they apply automatically to every
-- eligible student. Optional fees ONLY apply to a student if there's a
-- row here saying they're opted in (e.g. this kid uses school transport).
CREATE TABLE IF NOT EXISTS student_optional_fees (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  fee_item_id INTEGER NOT NULL REFERENCES fee_items(id),
  UNIQUE(student_id, fee_item_id)
);

-- ============================================================
-- THE RUNNING BALANCE - replaces the old flat students.balance column
-- ============================================================

-- One row per student per term. Owed = opening_balance + fees_charged -
-- amount_paid. Whatever's left (positive = still owed, negative = credit)
-- automatically becomes next term's opening_balance.
CREATE TABLE IF NOT EXISTS student_term_ledger (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  opening_balance NUMERIC NOT NULL DEFAULT 0,
  fees_charged NUMERIC NOT NULL DEFAULT 0,
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term_id)
);

-- ============================================================
-- STAFF ACCOUNTS - anchor entity for the future login system.
-- No passwords/auth yet (that's later), but building the audit trail
-- against a real account reference now means login just adds
-- authentication ON TOP of this same table, no rework needed.
-- ============================================================
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  full_name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'removed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_id, email)
);

-- Which staff account confirmed/rejected a transaction, and when.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS acted_by_staff_id INTEGER REFERENCES staff(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS acted_at TIMESTAMPTZ;

-- Password for staff login. Nullable because a staff account can exist
-- before a password is ever set (e.g. admin creates the account, staff
-- sets their own password on first login - a common real-world flow).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- ============================================================
-- WHICH CLASSES A SCHOOL ACTUALLY RUNS
-- ============================================================
-- classes stays global (the 15 levels are nationally standard), but each
-- school picks which ones it actually uses. This is also what makes
-- graduation correct: promotion needs to know a school's TRUE final class,
-- not just whichever class happens to have the highest sort_order globally.
CREATE TABLE IF NOT EXISTS school_classes (
  school_id INTEGER NOT NULL REFERENCES schools(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (school_id, class_id)
);

-- ============================================================
-- TRACKS WHICH TERMS HAVE ALREADY BEEN AUTO-CHARGED
-- ============================================================
-- The daily auto-charge check uses this to know "have I already billed
-- everyone for whatever term is current today, or is this a new one."
CREATE TABLE IF NOT EXISTS term_charge_runs (
  term_id INTEGER PRIMARY KEY REFERENCES terms(id),
  charged_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- STAFF ROLES, AUDIT LOG, LOGIN LOCK
-- ============================================================
-- Role: 'admin' (can change settings, reset bank credentials, add staff) or
-- 'staff' (works the payments: review, confirm, reject).
-- The column is added with default 'admin' ONCE, so every account that existed
-- before roles keeps working as an admin. Then the default for NEW accounts
-- is changed to 'staff' (this line is safe to run on every start).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'staff'));
ALTER TABLE staff ALTER COLUMN role SET DEFAULT 'staff';

-- Who did what, and when. Never store passwords, keys or secrets in "detail".
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  school_id INTEGER REFERENCES schools(id),
  staff_id INTEGER REFERENCES staff(id),
  action TEXT NOT NULL,            -- e.g. 'login', 'login_locked', 'staff_created', 'password_set'
  detail JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_school_time ON audit_log (school_id, created_at DESC);

-- Wrong-password counter per email (also for emails that do not exist, so an
-- attacker cannot tell which emails are real).
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,          -- lower case
  failures INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ
);

-- When a bank connection's credentials were last RESET (used for the 10-minute wait).
ALTER TABLE school_bank_connections ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ;

-- ============================================================
-- WHICH CHANNELS A SCHOOL PICKED (M-Pesa, KCB, Equity, Co-op)
-- ============================================================
-- A row = the school picked that channel (it gets a card). No row = hidden, but
-- the channel can be added again at any time. Unpicking NEVER disconnects anything.
-- The status (setup needed / waiting for bank / connected) is worked out when asked,
-- not stored, so it can never go out of date.
-- The first time this table is created, schools that ALREADY use a channel keep
-- seeing it. (This block does nothing on later starts, so a channel a school
-- hid on purpose is never added back.)
DO $$
BEGIN
  IF to_regclass('public.school_channels') IS NULL THEN
    CREATE TABLE school_channels (
      school_id INTEGER NOT NULL REFERENCES schools(id),
      channel TEXT NOT NULL CHECK (channel IN ('mpesa', 'kcb', 'equity', 'coop')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (school_id, channel)
    );
    INSERT INTO school_channels (school_id, channel)
      SELECT id, 'mpesa' FROM schools WHERE mpesa_shortcode IS NOT NULL
      UNION
      SELECT sbc.school_id, bp.code FROM school_bank_connections sbc
        JOIN bank_providers bp ON bp.id = sbc.provider_id WHERE bp.code IN ('mpesa', 'kcb', 'equity', 'coop')
      UNION
      SELECT school_id, source FROM transactions WHERE source IN ('mpesa', 'kcb', 'equity', 'coop') GROUP BY school_id, source
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- One bank account number = ONE school (per bank). Stops two schools claiming the same number,
-- which would make the webhook refuse to guess and drop the real owner's payments.
-- If two schools ALREADY share a number, the index cannot be built: the server still starts,
-- prints a warning, and the app-level check keeps protecting new registrations. Fix the duplicate and restart.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_account_per_provider
    ON school_bank_connections (provider_id, account_number) WHERE account_number IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'uniq_bank_account_per_provider NOT created: two schools already share a bank account number. Fix the duplicate, then restart.';
END $$;

-- When (and to which public address) this school's two M-Pesa addresses were registered with Safaricom.
-- Empty = not registered by us yet.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS mpesa_urls_registered_at TIMESTAMPTZ;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS mpesa_urls_registered_base TEXT;

-- The school's OWN secret code for its two M-Pesa addresses (40 random characters made by us,
-- stored encrypted). 'pending' exists only while we are registering with Safaricom, so a failed
-- or interrupted registration can never break a registration that already works.
-- Schools registered BEFORE this existed have none: they keep working with the older shared-secret code.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS mpesa_url_token_enc TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS mpesa_url_token_pending_enc TEXT;

-- One email = ONE account in the whole system (ignoring capitals). Login finds a person by email alone,
-- so the same email in two schools would lock the second school's person out.
-- If duplicates ALREADY exist the index cannot be built: the server still starts, prints a warning, and the
-- app-level checks keep protecting every NEW account. Fix the duplicate and restart.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_email_ci ON staff (lower(email)) WHERE email IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'uniq_staff_email_ci NOT created: the same email is already used by more than one account. Fix the duplicate, then restart.';
END $$;

-- ============================================================
-- ADMITTING STUDENTS: contacts, optional-fee choices, starting balance
-- ============================================================

-- Parents / guardians / anyone to call about a student. None is required and a student can
-- have as many as the school wants. sort_order 0 is the first one (it is also copied into
-- students.guardian_name / guardian_phone, which older code still reads).
CREATE TABLE IF NOT EXISTS student_contacts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  full_name TEXT,
  phone TEXT,
  relationship TEXT,                 -- 'Mother', 'Father', 'Guardian', 'Uncle' ... free text
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_contacts_student ON student_contacts (student_id);

-- The optional fees a student has CHOSEN (Lunch, Bus ...), remembered by NAME, not by a fee row.
-- Fee rows belong to one class and one term and get replaced when fees are edited, so a link to a
-- fee row could not follow a student into the next term or the next class. A name can.
-- Each term, the charge looks up what the student's CURRENT class asks for that name.
-- name_key is the name in lower case with spaces squeezed, so "Bus" and " bus " are one choice.
CREATE TABLE IF NOT EXISTS student_optional_choices (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (student_id, name_key)
);

-- Money a student already owed (or had paid ahead) when they joined the system, for the term they
-- were first billed in. It lives here, NOT only in the ledger, because the charge can be run again
-- and the ledger's opening balance is recalculated each time: this row is added back every time.
-- Positive = owed, negative = credit.
CREATE TABLE IF NOT EXISTS student_starting_balance (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  amount NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (student_id, term_id)
);


-- ============================================================
-- THE SCHOOL'S LIST OF OPTIONAL FEE NAMES (Lunch, Bus, Swimming ...)
-- ============================================================
-- Written once per school. When a class's fees are set, an optional fee is CHOSEN from this list
-- (with a price), not typed, so "Bus" can never turn into "Buss" and quietly drop a student's choice.
-- A name can still be added while setting fees (set-fees.js --new), so both ways work.
-- name_key = lower case with spaces squeezed, the same rule as student_optional_choices.
CREATE TABLE IF NOT EXISTS school_optional_fees (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (school_id, name_key)
);

-- ============================================================
-- FEE STRUCTURE v2: a reusable template per class and TERM NUMBER (no year), versioned
-- ============================================================
-- The structure is only a template. It can be edited any day. Every save is a NEW version (old versions are
-- never changed or deleted, a trigger below refuses it). The newest version is the "latest".
-- Billing (term_billing + term_fee_locks below) is what locks fees for one real term.
-- Mandatory and optional fees of a class and term are saved together as one version.
-- (The old fee_items / fee_item_history tables stay as they were, only for history. Nothing reads them any more.)
DO $$
BEGIN
  IF to_regclass('public.fee_templates') IS NULL THEN
    CREATE TABLE fee_templates (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL REFERENCES schools(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      term_number SMALLINT NOT NULL CHECK (term_number IN (1, 2, 3)),
      version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (school_id, class_id, term_number, version)
    );
    CREATE TABLE fee_template_items (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES fee_templates(id),
      name TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK (amount > 0),
      is_mandatory BOOLEAN NOT NULL
    );
    CREATE INDEX idx_fee_template_items_template ON fee_template_items (template_id);
  END IF;
END $$;

-- Billing: ONE row per school and term, ever. The primary key is what makes a second billing impossible.
CREATE TABLE IF NOT EXISTS term_billing (
  school_id INTEGER NOT NULL REFERENCES schools(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  billed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  students_billed INTEGER NOT NULL DEFAULT 0,
  via TEXT,                                -- 'auto' | 'charge-term' | 'migrated'
  PRIMARY KEY (school_id, term_id)
);

-- Which version of a class's fees was locked for a real term. Written once, at billing, never changed.
CREATE TABLE IF NOT EXISTS term_fee_locks (
  school_id INTEGER NOT NULL REFERENCES schools(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  template_id INTEGER NOT NULL REFERENCES fee_templates(id),
  PRIMARY KEY (school_id, term_id, class_id)
);

-- One-time move of the old per-term fee_items into templates. Each old term becomes one version, oldest year
-- first, so the newest year is the latest version. Terms that already have student ledgers are marked as billed
-- and locked to the version they used. Runs only when fee_templates is empty, and only once.
DO $$
DECLARE moved INTEGER;
BEGIN
  IF to_regclass('public.fee_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fee_templates)
     AND EXISTS (SELECT 1 FROM fee_items WHERE class_id IS NOT NULL) THEN
    CREATE TEMP TABLE _fx_src ON COMMIT DROP AS
      SELECT x.school_id, x.class_id, x.term_id, x.term_number,
             ROW_NUMBER() OVER (PARTITION BY x.school_id, x.class_id, x.term_number ORDER BY x.year)::int AS version
      FROM (SELECT DISTINCT fi.school_id, fi.class_id, fi.term_id, t.term_number, ay.year
            FROM fee_items fi JOIN terms t ON t.id = fi.term_id JOIN academic_years ay ON ay.id = t.academic_year_id
            WHERE fi.class_id IS NOT NULL) x;
    INSERT INTO fee_templates (school_id, class_id, term_number, version)
      SELECT school_id, class_id, term_number, version FROM _fx_src;
    INSERT INTO fee_template_items (template_id, name, amount, is_mandatory)
      SELECT ft.id, fi.name, fi.amount, fi.is_mandatory
      FROM fee_items fi
      JOIN _fx_src s ON s.school_id = fi.school_id AND s.class_id = fi.class_id AND s.term_id = fi.term_id
      JOIN fee_templates ft ON ft.school_id = s.school_id AND ft.class_id = s.class_id AND ft.term_number = s.term_number AND ft.version = s.version
      WHERE fi.amount > 0;
    INSERT INTO term_billing (school_id, term_id, students_billed, via)
      SELECT s.school_id, l.term_id, COUNT(DISTINCT l.student_id), 'migrated'
      FROM student_term_ledger l JOIN students s ON s.id = l.student_id
      GROUP BY s.school_id, l.term_id
      ON CONFLICT DO NOTHING;
    INSERT INTO term_fee_locks (school_id, term_id, class_id, template_id)
      SELECT src.school_id, src.term_id, src.class_id, ft.id
      FROM _fx_src src
      JOIN fee_templates ft ON ft.school_id = src.school_id AND ft.class_id = src.class_id AND ft.term_number = src.term_number AND ft.version = src.version
      WHERE EXISTS (SELECT 1 FROM term_billing b WHERE b.school_id = src.school_id AND b.term_id = src.term_id)
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'fee structure v2: % billed term(s) locked to the fees they used', moved;
    IF EXISTS (SELECT 1 FROM fee_items WHERE class_id IS NULL) THEN
      RAISE WARNING 'fee structure v2: some old fee lines were school-wide (no class). They were NOT moved. Set those fees per class again.';
    END IF;
  END IF;
END $$;

-- Safety nets in the database itself (not only in the code): versions, billing records and locks can be
-- added but never changed or removed. A second billing of the same school and term is refused by the primary key.
CREATE OR REPLACE FUNCTION karo_no_change() RETURNS trigger AS $f$
BEGIN
  RAISE EXCEPTION '% rows can not be changed or deleted (they are history)', TG_TABLE_NAME USING ERRCODE = '23000';
END;
$f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS no_change_fee_templates ON fee_templates;
CREATE TRIGGER no_change_fee_templates BEFORE UPDATE OR DELETE ON fee_templates FOR EACH ROW EXECUTE FUNCTION karo_no_change();
DROP TRIGGER IF EXISTS no_change_fee_template_items ON fee_template_items;
CREATE TRIGGER no_change_fee_template_items BEFORE UPDATE OR DELETE ON fee_template_items FOR EACH ROW EXECUTE FUNCTION karo_no_change();
DROP TRIGGER IF EXISTS no_change_term_billing ON term_billing;
CREATE TRIGGER no_change_term_billing BEFORE UPDATE OR DELETE ON term_billing FOR EACH ROW EXECUTE FUNCTION karo_no_change();
DROP TRIGGER IF EXISTS no_change_term_fee_locks ON term_fee_locks;
CREATE TRIGGER no_change_term_fee_locks BEFORE UPDATE OR DELETE ON term_fee_locks FOR EACH ROW EXECUTE FUNCTION karo_no_change();

-- ============================================================
-- PER-SCHOOL CALENDAR
-- The year and its 3 term slots (academic_years, terms) are shared, but every school has its OWN dates for each
-- term. School admins set their own. A term "starts" for a school on ITS start date.
-- ============================================================
CREATE TABLE IF NOT EXISTS school_term_dates (
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, term_id),
  CHECK (end_date > start_date)
);

-- One time: the old shared dates become every school's own dates, then the shared columns are emptied so a school
-- added later starts with a blank calendar (it does not quietly inherit someone else's dates).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM terms WHERE start_date IS NOT NULL AND end_date IS NOT NULL) THEN
    INSERT INTO school_term_dates (school_id, term_id, start_date, end_date)
      SELECT s.id, t.id, t.start_date, t.end_date FROM schools s CROSS JOIN terms t
      WHERE t.start_date IS NOT NULL AND t.end_date IS NOT NULL
      ON CONFLICT DO NOTHING;
    UPDATE terms SET start_date = NULL, end_date = NULL WHERE start_date IS NOT NULL OR end_date IS NOT NULL;
    RAISE NOTICE 'terms: the shared dates were copied to every school';
  END IF;
END $$;

-- Safety net in the database: a start date that has been reached never moves, and an ended term never changes.
CREATE OR REPLACE FUNCTION karo_term_dates_guard() RETURNS trigger AS $f$
BEGIN
  IF OLD.start_date <= CURRENT_DATE AND NEW.start_date <> OLD.start_date THEN
    RAISE EXCEPTION 'This term already started on %, so its start date can not change.', OLD.start_date USING ERRCODE = '23000';
  END IF;
  IF OLD.end_date < CURRENT_DATE AND NEW.end_date <> OLD.end_date THEN
    RAISE EXCEPTION 'This term ended on %, so its dates can not change.', OLD.end_date USING ERRCODE = '23000';
  END IF;
  IF NEW.term_id <> OLD.term_id OR NEW.school_id <> OLD.school_id THEN
    RAISE EXCEPTION 'A term date row can not be moved to another term or school.' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_school_term_dates ON school_term_dates;
CREATE TRIGGER guard_school_term_dates BEFORE UPDATE ON school_term_dates FOR EACH ROW EXECUTE FUNCTION karo_term_dates_guard();

-- ============================================================
-- REVERSING A WRONG MANUAL PAYMENT
-- The payment row stays (it is history); a reversal row points at it, says who and why, and can only exist once.
-- The payment itself is marked 'rejected' so every total that skips rejected payments skips it, and the student's
-- ledger is reduced by the same amount in the same transaction (src/services/studentSheet.js).
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_reversals (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  reason TEXT NOT NULL,
  reversed_by_staff_id INTEGER REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS no_change_payment_reversals ON payment_reversals;
CREATE TRIGGER no_change_payment_reversals BEFORE UPDATE OR DELETE ON payment_reversals FOR EACH ROW EXECUTE FUNCTION karo_no_change();

-- ============================================================
-- STAFF: OWNER, INVITES, SUSPENSION, SAFE SIGN-OUT
-- Roles stay 'admin' | 'staff'. The OWNER is an admin with is_owner = true: one per school (the database enforces
-- it), picked when the school is made, and nobody can demote, suspend or remove them (guard trigger below).
-- Ownership only moves through the transfer in src/services/staffAdmin.js, which switches the guard off for itself.
-- status: 'invited' (no password yet) | 'active' | 'suspended' | 'removed' (old).
-- token_version goes up when a password is reset/changed or someone is suspended; older login tokens then stop working.
-- ============================================================
ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES staff(id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_one_owner_per_school ON staff (school_id) WHERE is_owner;

-- A school that has no owner yet (made before owners existed) gets its earliest active admin as owner.
UPDATE staff s SET is_owner = TRUE
WHERE s.id = (SELECT x.id FROM staff x WHERE x.school_id = s.school_id AND x.role = 'admin' AND x.status = 'active' ORDER BY x.id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.school_id = s.school_id AND o.is_owner);

CREATE OR REPLACE FUNCTION karo_owner_guard() RETURNS trigger AS $f$
BEGIN
  IF COALESCE(current_setting('karo.owner_transfer', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner THEN RAISE EXCEPTION 'The Main Admin can not be removed.' USING ERRCODE = '23000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_owner AND (NOT NEW.is_owner OR NEW.role <> 'admin' OR NEW.status <> 'active' OR NEW.school_id <> OLD.school_id) THEN
    RAISE EXCEPTION 'The Main Admin can not be demoted, suspended or removed. Hand over the Main Admin role first.' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_staff_owner ON staff;
CREATE TRIGGER guard_staff_owner BEFORE UPDATE OR DELETE ON staff FOR EACH ROW EXECUTE FUNCTION karo_owner_guard();

-- One-time links: invite (set your first password), reset (new password), email_change (confirm a new address).
-- Only a hash of the link is stored, so a leaked database gives nobody a working link.
CREATE TABLE IF NOT EXISTS staff_tokens (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset', 'email_change')),
  token_hash TEXT NOT NULL UNIQUE,
  new_email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_tokens_staff ON staff_tokens (staff_id, purpose, created_at DESC);

-- ============================================================
-- THE ACTIVITY LOG ONLY GROWS
-- Nobody (no screen, no script, no admin) can edit or delete a line of audit_log.
-- ============================================================
DROP TRIGGER IF EXISTS no_change_audit_log ON audit_log;
CREATE TRIGGER no_change_audit_log BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION karo_no_change();
CREATE INDEX IF NOT EXISTS idx_audit_school_id ON audit_log (school_id, id DESC);

-- ============================================================
-- SCHOOL PROFILE (name, motto, contact, logo) AND PERSONAL PINs
-- The logo is stored in the database itself (a small PNG/JPEG/WebP, checked by its real bytes), so hosting needs no file storage.
-- A PIN is personal (an Admin's), stored only as a hash. It guards sensitive actions: bank and M-Pesa settings, payment channels,
-- staff access, renaming the school. Wrong PINs are counted per person; 5 in a row locks PIN use for 15 minutes.
-- ============================================================
ALTER TABLE schools ADD COLUMN IF NOT EXISTS motto TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS county TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS receipt_footer TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS logo_data BYTEA;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS logo_type TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

-- second school phone number (optional), printed on receipts
ALTER TABLE schools ADD COLUMN IF NOT EXISTS phone2 TEXT;