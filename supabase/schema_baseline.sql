-- Local replica of the production tables (created via the dashboard before migrations existed).
-- NOT a migration: used only to bootstrap a scratch database for scripts/simulate_allocation.py.
-- Production already has these tables and their data; never run this against production.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
-- Supabase cloud grants EXECUTE on new public-schema functions to these roles by default; mirror that so
-- the migration's revokes are actually exercised locally.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE study_stages (
  id text PRIMARY KEY,
  name text,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stage_prompt_targets (
  stage_id text NOT NULL REFERENCES study_stages (id),
  category text NOT NULL,
  prompt_id text NOT NULL,
  target integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  group_id text,
  weight numeric,
  PRIMARY KEY (stage_id, category, prompt_id)
);

CREATE TABLE assignments (
  participant_key text NOT NULL,
  stage_id text NOT NULL,
  category text NOT NULL,
  prompt_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'expired')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (participant_key, stage_id, category)
);

ALTER TABLE study_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_prompt_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
