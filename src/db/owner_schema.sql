-- The platform owner (you, at Zuvy): can add schools and see the list. Not a school staff member.
CREATE TABLE IF NOT EXISTS platform_owners (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schools that ask to join through the public apply page. Nothing here creates a school: you read it, contact them, and add the school yourself.
CREATE TABLE IF NOT EXISTS school_applications (
  id SERIAL PRIMARY KEY,
  school_name TEXT NOT NULL,
  town TEXT,
  contact_name TEXT NOT NULL,
  contact_role TEXT,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  students_range TEXT,
  bank TEXT,
  collects_via TEXT,
  start_when TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','accepted','declined')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A paused school: its staff cannot sign in. Payments keep being recorded.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;