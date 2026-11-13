-- Milestone 7: RLS for dashboard login and sessions, and the admin console role.
-- Hand-written (drizzle-kit generate --custom); keep in sync with src/schema.ts.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['login_tokens','dashboard_sessions','capture_reviews']
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

-- A magic link or session cookie arrives before the tenant is known. With
-- app.login_token_hash / app.session_hash set, only the row with that exact
-- hash is readable (to learn its business); everything else happens inside
-- that business's scope. Same pattern as phone_lookup.
CREATE POLICY login_lookup ON login_tokens FOR SELECT
  USING (token_hash = current_setting('app.login_token_hash', true));
--> statement-breakpoint
CREATE POLICY session_lookup ON dashboard_sessions FOR SELECT
  USING (session_hash = current_setting('app.session_hash', true));
--> statement-breakpoint

GRANT SELECT, INSERT ON login_tokens, dashboard_sessions TO bukuwa_app;
--> statement-breakpoint
GRANT UPDATE (used_at) ON login_tokens TO bukuwa_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON dashboard_sessions TO bukuwa_app;
--> statement-breakpoint
GRANT SELECT ON capture_reviews TO bukuwa_app;
--> statement-breakpoint

-- Staff login: not tenant-scoped (like wa_inbound), hashes only.
GRANT SELECT, INSERT ON admin_login_tokens, admin_sessions TO bukuwa_app;
--> statement-breakpoint
GRANT UPDATE (used_at) ON admin_login_tokens TO bukuwa_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON admin_sessions TO bukuwa_app;
--> statement-breakpoint

-- Admin console role: reads across businesses for support and the review
-- queue, never writes the ledger. Not BYPASSRLS: it sees rows only through the
-- admin_read policies below. The API's login role must be a member
-- (GRANT bukuwa_admin TO <api role>) and switches with SET LOCAL ROLE only
-- after verifying an admin session.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bukuwa_admin') THEN
    CREATE ROLE bukuwa_admin NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO bukuwa_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_business_id() TO bukuwa_admin;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','accounts','journals','journal_lines','captures','messages','audit_log','capture_reviews']
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO bukuwa_admin', t);
    EXECUTE format('CREATE POLICY admin_read ON %I FOR SELECT TO bukuwa_admin USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT INSERT ON capture_reviews, audit_log TO bukuwa_admin;
--> statement-breakpoint
CREATE POLICY admin_write ON capture_reviews FOR INSERT TO bukuwa_admin WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY admin_write ON audit_log FOR INSERT TO bukuwa_admin WITH CHECK (true);
