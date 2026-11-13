-- Milestone 6: RLS and privileges for reports and tax notices, and the seeded
-- tax rules. Hand-written (drizzle-kit generate --custom); keep in sync with src/schema.ts.

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON reports
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint
-- Generated reports are evidence of what was exported: insert and read only.
GRANT SELECT, INSERT ON reports TO bukuwa_app;
--> statement-breakpoint

ALTER TABLE tax_notice_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tax_notice_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tax_notice_schedules
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint
-- Same pattern as summary_schedules: with app.tax_notice_scan = 'on' the
-- scheduler may read schedule rows (business id and timing only) to find the
-- due ones, then does all work inside that business's scope. SELECT only.
CREATE POLICY scheduler_scan ON tax_notice_schedules FOR SELECT
  USING (current_setting('app.tax_notice_scan', true) = 'on');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tax_notice_schedules TO bukuwa_app;
--> statement-breakpoint

-- Tax rules are global configuration: readable by the app, changed only by migrations.
GRANT SELECT ON tax_profiles TO bukuwa_app;
--> statement-breakpoint

-- Final tax on gross turnover for individual UMKM (spec 8.1). PP 23/2018 set
-- 0.5% from July 2018; UU HPP / PP 55/2022 added the Rp 500M yearly exemption
-- for individuals from tax year 2022. A regulation change is a new row here.
-- Confirm with a konsultan pajak before launch (spec 10, open questions).
INSERT INTO tax_profiles (regime, name, rate_bps, annual_exempt_threshold_idr, annual_turnover_cap_idr, payment_due_day, valid_from, valid_to)
VALUES
  ('umkm_final_individual', 'PPh Final UMKM 0,5% (PP 23/2018)', 50, 0, 4800000000, 15, '2018-07-01', '2021-12-31'),
  ('umkm_final_individual', 'PPh Final UMKM 0,5% (PP 55/2022)', 50, 500000000, 4800000000, 15, '2022-01-01', NULL);
--> statement-breakpoint

-- Existing businesses get the month-end tax notice (08:00 local on the 1st;
-- the worker recomputes the time from config after the first send). Needs a
-- role that bypasses RLS on businesses; where it doesn't, no rows are added
-- and onboarding/first use creates them instead.
INSERT INTO tax_notice_schedules (business_id, next_run_at)
SELECT b.id, (date_trunc('month', now() AT TIME ZONE b.timezone) + interval '1 month' + interval '8 hours') AT TIME ZONE b.timezone
FROM businesses b
ON CONFLICT DO NOTHING;
