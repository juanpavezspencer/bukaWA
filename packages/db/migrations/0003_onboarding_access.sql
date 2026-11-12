-- Onboarding sessions: not tenant-scoped (the business doesn't exist yet).
-- DELETE is allowed: a session is removed once the business is created.
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_sessions TO bukuwa_app;
--> statement-breakpoint

-- Resolve an inbound sender to their business. With no business selected, the
-- worker sets app.phone_hash to the sender's hash and may read exactly that
-- one users row (the sender's own, authenticated by WhatsApp). Permissive
-- policies are OR-ed with tenant_isolation; this one is SELECT only.
CREATE POLICY phone_lookup ON users FOR SELECT
  USING (phone_hash = nullif(current_setting('app.phone_hash', true), ''));
