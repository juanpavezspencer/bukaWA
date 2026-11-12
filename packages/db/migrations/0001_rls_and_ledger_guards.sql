-- Row-level security, append-only ledger, and the balanced-journal constraint.
-- Hand-written (drizzle-kit generate --custom); keep in sync with src/schema.ts.

-- Application role. Runtime connections either log in as a member of this role
-- or `SET ROLE bukuwa_app`. It is never a superuser and never BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bukuwa_app') THEN
    CREATE ROLE bukuwa_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Current tenant, set per transaction by withBusiness(): set_config('app.business_id', ..., true).
-- Unset or empty -> NULL -> every policy evaluates to false (no rows).
CREATE OR REPLACE FUNCTION app_current_business_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.business_id', true), '')::uuid
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO bukuwa_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_business_id() TO bukuwa_app;
--> statement-breakpoint

-- Tenant tables -----------------------------------------------------------------
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON businesses
  USING (id = app_current_business_id())
  WITH CHECK (id = app_current_business_id());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','accounts','contacts','journals','journal_lines','captures','messages','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business_id()) WITH CHECK (business_id = app_current_business_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Privileges: ledger and audit tables are insert/select only for the app.
GRANT SELECT, INSERT, UPDATE ON businesses, users, accounts, contacts, captures TO bukuwa_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON journals, journal_lines, messages, audit_log TO bukuwa_app;
--> statement-breakpoint
-- Webhook inbox: not tenant-scoped, no DELETE.
GRANT SELECT, INSERT, UPDATE ON wa_inbound TO bukuwa_app;
--> statement-breakpoint

-- Append-only guard ---------------------------------------------------------------
-- Applies to every role, including table owners, so a migration or console
-- session can't silently rewrite history either. Corrections are reversals.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: ledger is append-only, post a reversal', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Balanced-journal constraint -----------------------------------------------------
-- Deferred to commit so a journal and its lines can be inserted in one transaction.
-- Fires for the journal row (catches journals with no lines) and for each line.
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
  n_lines integer;
  total_debit numeric;
  total_credit numeric;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN
    jid := NEW.id;
  ELSE
    jid := NEW.journal_id;
  END IF;

  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO n_lines, total_debit, total_credit
    FROM journal_lines WHERE journal_id = jid;

  IF n_lines < 2 THEN
    RAISE EXCEPTION 'journal % has % line(s); at least 2 required', jid, n_lines
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_balanced';
  END IF;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'journal % is unbalanced: debit % <> credit %', jid, total_debit, total_credit
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_balanced';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_balanced_on_journal
  AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_balanced_on_line
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();
