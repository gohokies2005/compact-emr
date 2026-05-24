-- Compact EMR Phase 1 schema. Intentionally idempotent so first deploy can be retried safely.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE yes_no_unknown AS ENUM ('yes', 'no', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE claim_type AS ENUM ('initial', 'supplemental', 'hlr', 'appeal_bva');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE case_status AS ENUM ('intake', 'records', 'viability', 'drafting', 'physician_review', 'correction_requested', 'correction_review', 'delivered', 'paid', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE cds_verdict AS ENUM ('accept', 'caution', 'reject', 'not_yet_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE draft_job_state AS ENUM ('queued', 'running', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE correction_reason AS ENUM ('veteran_added_info', 'physician_caught_error', 'ops_caught_error', 'va_examiner_feedback', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_tier AS ENUM ('free_first', 'free_our_fault', 'paid_50');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE physician_activity AS ENUM ('letter_review', 'correction_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE email_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE payment_kind AS ENUM ('review_50', 'letter_350', 'refund', 'correction_fee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app_role AS ENUM ('physician', 'ops_staff', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION compact_emr_touch_version() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS cognito_groups (
  name app_role PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cognito_sub text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS app_users_email_idx ON app_users(email);

CREATE TABLE IF NOT EXISTS app_user_roles (
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS app_user_roles_role_idx ON app_user_roles(role);

CREATE TABLE IF NOT EXISTS veterans (
  id text PRIMARY KEY,
  last_name text NOT NULL,
  first_name text NOT NULL,
  dob date NOT NULL,
  email text NOT NULL,
  phone text,
  address text,
  branch text NOT NULL,
  service_start_year int NOT NULL,
  service_end_year int NOT NULL,
  combat_veteran yes_no_unknown NOT NULL,
  pact_area yes_no_unknown NOT NULL,
  tera_conceded yes_no_unknown NOT NULL,
  height_in int,
  weight_lb int,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(last_name,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(email,''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS veterans_last_first_idx ON veterans(last_name, first_name);
CREATE INDEX IF NOT EXISTS veterans_email_idx ON veterans(email);
CREATE INDEX IF NOT EXISTS veterans_branch_idx ON veterans(branch);
CREATE INDEX IF NOT EXISTS veterans_search_vector_gin_idx ON veterans USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS sc_conditions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  veteran_id text NOT NULL REFERENCES veterans(id) ON DELETE CASCADE,
  condition text NOT NULL,
  dc_code text,
  rating_pct int,
  granted_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sc_conditions_veteran_id_idx ON sc_conditions(veteran_id);
CREATE INDEX IF NOT EXISTS sc_conditions_condition_idx ON sc_conditions(condition);
CREATE INDEX IF NOT EXISTS sc_conditions_dc_code_idx ON sc_conditions(dc_code);

CREATE TABLE IF NOT EXISTS active_problems (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  veteran_id text NOT NULL REFERENCES veterans(id) ON DELETE CASCADE,
  problem text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS active_problems_veteran_id_idx ON active_problems(veteran_id);
CREATE INDEX IF NOT EXISTS active_problems_problem_idx ON active_problems(problem);

CREATE TABLE IF NOT EXISTS active_medications (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  veteran_id text NOT NULL REFERENCES veterans(id) ON DELETE CASCADE,
  drug_name text NOT NULL,
  dose text,
  frequency text,
  indication text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS active_medications_veteran_id_idx ON active_medications(veteran_id);
CREATE INDEX IF NOT EXISTS active_medications_drug_name_idx ON active_medications(drug_name);
CREATE INDEX IF NOT EXISTS active_medications_indication_idx ON active_medications(indication);

CREATE TABLE IF NOT EXISTS physicians (
  id text PRIMARY KEY,
  full_name text NOT NULL,
  npi text NOT NULL UNIQUE,
  specialty text NOT NULL,
  medical_license text NOT NULL,
  email text NOT NULL,
  phone text,
  signature_image_s3_key text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS physicians_full_name_idx ON physicians(full_name);
CREATE INDEX IF NOT EXISTS physicians_npi_idx ON physicians(npi);
CREATE INDEX IF NOT EXISTS physicians_email_idx ON physicians(email);
CREATE INDEX IF NOT EXISTS physicians_active_idx ON physicians(active);

CREATE TABLE IF NOT EXISTS cases (
  id text PRIMARY KEY,
  veteran_id text NOT NULL REFERENCES veterans(id) ON DELETE CASCADE,
  claimed_condition text NOT NULL,
  claim_type claim_type NOT NULL,
  framing_choice text,
  upstream_sc_condition text,
  veteran_statement text,
  in_service_event text,
  status case_status NOT NULL DEFAULT 'intake',
  cds_verdict cds_verdict NOT NULL DEFAULT 'not_yet_run',
  cds_odds_pct int,
  cds_rationale jsonb,
  assigned_physician_id text REFERENCES physicians(id),
  refund_eligible boolean NOT NULL DEFAULT false,
  current_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS cases_veteran_id_idx ON cases(veteran_id);
CREATE INDEX IF NOT EXISTS cases_assigned_physician_id_idx ON cases(assigned_physician_id);
CREATE INDEX IF NOT EXISTS cases_claimed_condition_idx ON cases(claimed_condition);
CREATE INDEX IF NOT EXISTS cases_status_updated_at_idx ON cases(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS cases_veteran_status_idx ON cases(veteran_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  filename text NOT NULL,
  size_bytes bigint NOT NULL,
  content_type text NOT NULL,
  doc_tag text,
  s3_key text NOT NULL UNIQUE,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS documents_case_id_idx ON documents(case_id);
CREATE INDEX IF NOT EXISTS documents_case_doc_tag_idx ON documents(case_id, doc_tag);
CREATE INDEX IF NOT EXISTS documents_filename_idx ON documents(filename);
CREATE INDEX IF NOT EXISTS documents_uploaded_by_idx ON documents(uploaded_by);

CREATE TABLE IF NOT EXISTS draft_jobs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version int NOT NULL,
  sqs_message_id text,
  state draft_job_state NOT NULL DEFAULT 'queued',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_jobs_case_id_idx ON draft_jobs(case_id);
CREATE INDEX IF NOT EXISTS draft_jobs_state_idx ON draft_jobs(state);
CREATE INDEX IF NOT EXISTS draft_jobs_case_version_idx ON draft_jobs(case_id, version);

CREATE TABLE IF NOT EXISTS corrections (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_version int NOT NULL,
  to_version int,
  correction_reason correction_reason NOT NULL,
  correction_note text NOT NULL,
  affects_sections jsonb NOT NULL,
  billing_tier billing_tier NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS corrections_case_id_idx ON corrections(case_id);
CREATE INDEX IF NOT EXISTS corrections_requested_by_idx ON corrections(requested_by);
CREATE INDEX IF NOT EXISTS corrections_approved_by_idx ON corrections(approved_by);
CREATE INDEX IF NOT EXISTS corrections_billing_tier_idx ON corrections(billing_tier);

CREATE TABLE IF NOT EXISTS physician_compensation (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  physician_id text NOT NULL REFERENCES physicians(id),
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  activity physician_activity NOT NULL,
  amount_cents int NOT NULL,
  accrued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  payroll_batch_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS physician_compensation_physician_id_idx ON physician_compensation(physician_id);
CREATE INDEX IF NOT EXISTS physician_compensation_case_id_idx ON physician_compensation(case_id);
CREATE INDEX IF NOT EXISTS physician_compensation_activity_idx ON physician_compensation(activity);
CREATE INDEX IF NOT EXISTS physician_compensation_accrued_at_idx ON physician_compensation(accrued_at);
CREATE INDEX IF NOT EXISTS physician_compensation_paid_at_idx ON physician_compensation(paid_at);
CREATE INDEX IF NOT EXISTS physician_compensation_payroll_batch_id_idx ON physician_compensation(payroll_batch_id);

CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  direction email_direction NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  sent_at timestamptz NOT NULL,
  gmail_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS emails_case_id_idx ON emails(case_id);
CREATE INDEX IF NOT EXISTS emails_sent_at_idx ON emails(sent_at);
CREATE INDEX IF NOT EXISTS emails_from_address_idx ON emails(from_address);
CREATE INDEX IF NOT EXISTS emails_to_address_idx ON emails(to_address);
CREATE INDEX IF NOT EXISTS emails_gmail_message_id_idx ON emails(gmail_message_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  case_id text,
  veteran_id text,
  actor_user_id text,
  action text NOT NULL,
  details_json jsonb,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE IF NOT EXISTS activity_log_default PARTITION OF activity_log DEFAULT;
CREATE INDEX IF NOT EXISTS activity_log_case_id_idx ON activity_log(case_id);
CREATE INDEX IF NOT EXISTS activity_log_veteran_id_idx ON activity_log(veteran_id);
CREATE INDEX IF NOT EXISTS activity_log_actor_user_id_idx ON activity_log(actor_user_id);
CREATE INDEX IF NOT EXISTS activity_log_action_idx ON activity_log(action);
CREATE INDEX IF NOT EXISTS activity_log_ts_idx ON activity_log(ts);
DO $$ BEGIN
  ALTER TABLE activity_log ADD CONSTRAINT activity_log_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE activity_log ADD CONSTRAINT activity_log_veteran_id_fkey FOREIGN KEY (veteran_id) REFERENCES veterans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind payment_kind NOT NULL,
  amount_cents int NOT NULL,
  stripe_charge_id text,
  status text NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS payments_case_id_idx ON payments(case_id);
CREATE INDEX IF NOT EXISTS payments_kind_idx ON payments(kind);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
CREATE INDEX IF NOT EXISTS payments_settled_at_idx ON payments(settled_at);
CREATE INDEX IF NOT EXISTS payments_stripe_charge_id_idx ON payments(stripe_charge_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['app_users','veterans','sc_conditions','active_problems','active_medications','physicians','cases','documents','draft_jobs','corrections','physician_compensation','emails','payments']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_version ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_touch_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION compact_emr_touch_version()', table_name, table_name);
  END LOOP;
END $$;

INSERT INTO cognito_groups(name) VALUES ('physician'), ('ops_staff'), ('admin') ON CONFLICT DO NOTHING;
INSERT INTO app_users(cognito_sub, email)
VALUES (coalesce(NULLIF(current_setting('app.bootstrap_admin_sub', true), ''), 'COGNITO_SUB_TBD'), coalesce(NULLIF(current_setting('app.bootstrap_admin_email', true), ''), 'admin@example.invalid'))
ON CONFLICT (cognito_sub) DO NOTHING;
INSERT INTO app_user_roles(user_id, role)
SELECT id, 'admin'::app_role FROM app_users WHERE cognito_sub = coalesce(NULLIF(current_setting('app.bootstrap_admin_sub', true), ''), 'COGNITO_SUB_TBD')
ON CONFLICT DO NOTHING;
