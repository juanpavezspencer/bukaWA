ALTER TABLE summary_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE summary_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON summary_schedules
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint
-- The scheduler has no business selected: with app.summary_scan = 'on' it may
-- read schedule rows (business id and timing only) to find the due ones, then
-- does all work for a business inside that business's scope. SELECT only.
CREATE POLICY scheduler_scan ON summary_schedules FOR SELECT
  USING (current_setting('app.summary_scan', true) = 'on');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON summary_schedules TO bukuwa_app;
