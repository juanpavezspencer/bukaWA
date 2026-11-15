-- Milestone 8: RLS and grants for usage metering, pilot invites and erasure,
-- plus erase_business(), the only path that deletes ledger rows.
-- Hand-written (drizzle-kit generate --custom); keep in sync with src/schema.ts.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_events','erasure_requests']
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

-- Metering is insert-only for the app.
GRANT SELECT, INSERT ON usage_events TO bukuwa_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON erasure_requests TO bukuwa_app;
--> statement-breakpoint
-- A cancelled request can be renewed (new dates). The function re-checks the
-- dates before deleting anything.
GRANT UPDATE (requested_at, scheduled_for, cancelled_at) ON erasure_requests TO bukuwa_app;
--> statement-breakpoint
-- Like the summary scheduler: with app.erasure_scan = 'on' and no business
-- selected, the worker may read request rows to find the due ones. SELECT only.
CREATE POLICY erasure_scan ON erasure_requests FOR SELECT
  USING (current_setting('app.erasure_scan', true) = 'on');
--> statement-breakpoint

-- Pilot invites: not tenant-scoped. Onboarding reads a code and counts a use.
GRANT SELECT ON pilot_invites TO bukuwa_app;
--> statement-breakpoint
GRANT UPDATE (uses) ON pilot_invites TO bukuwa_app;
--> statement-breakpoint

-- Admin console: costs, pilot metrics, invites, erasure status.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_events','erasure_requests']
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO bukuwa_admin', t);
    EXECUTE format('CREATE POLICY admin_read ON %I FOR SELECT TO bukuwa_admin USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT ON pilot_invites TO bukuwa_admin;
--> statement-breakpoint
GRANT SELECT ON erasure_log TO bukuwa_admin;
--> statement-breakpoint
-- Reply-time metric (spec 10: median under 4 s text / 12 s photos). Timing
-- columns only; never the sender's number or the payload.
GRANT SELECT (type, received_at, processed_at) ON wa_inbound TO bukuwa_admin;
--> statement-breakpoint

-- Erasure ----------------------------------------------------------------------
-- The append-only guard stays in force for everything except one deletion:
-- inside erase_business() for that business. app.erasing_business is set only
-- by that function, and the app role has no DELETE grant on ledger tables, so
-- the setting alone opens nothing.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.business_id::text = current_setting('app.erasing_business', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: ledger is append-only, post a reversal', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint

-- Delete every row of one business (UU PDP erasure on the owner's request).
-- Refuses unless an uncancelled erasure request for it is due. Runs as the
-- function owner; selects the tenant so FORCE'd RLS policies still pass.
-- wa_inbound rows (not tenant-scoped) are matched by the owner's number.
-- Keep the table list in step with TENANT_TABLES (a test checks it).
CREATE OR REPLACE FUNCTION erase_business(p_business uuid, p_owner_phone text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  req erasure_requests%ROWTYPE;
  counts jsonb := '{}'::jsonb;
  n bigint;
  t text;
BEGIN
  PERFORM set_config('app.business_id', p_business::text, true);
  SELECT * INTO req FROM erasure_requests WHERE business_id = p_business FOR UPDATE;
  IF NOT FOUND OR req.cancelled_at IS NOT NULL OR req.scheduled_for > p_now THEN
    RAISE EXCEPTION 'no due erasure request for business %', p_business
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.erasing_business', p_business::text, true);

  -- Children before parents.
  FOREACH t IN ARRAY ARRAY[
    'capture_reviews','usage_events','login_tokens','dashboard_sessions','reports',
    'summary_schedules','tax_notice_schedules','category_rules','captures',
    'journal_lines','journals','contacts','accounts','messages','audit_log',
    'users','erasure_requests']
  LOOP
    EXECUTE format('DELETE FROM %I WHERE business_id = $1', t) USING p_business;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;
  DELETE FROM businesses WHERE id = p_business;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('businesses', n);

  DELETE FROM wa_inbound
    WHERE regexp_replace(from_phone, '\D', '', 'g') = regexp_replace(coalesce(p_owner_phone, ''), '\D', '', 'g');
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('wa_inbound', n);

  INSERT INTO erasure_log (subject_id, requested_at, executed_at, row_counts)
    VALUES (p_business, req.requested_at, p_now, counts);
  PERFORM set_config('app.erasing_business', '', true);
  RETURN counts;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_business(uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION erase_business(uuid, text, timestamptz) TO bukuwa_app;
