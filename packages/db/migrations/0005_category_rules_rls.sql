ALTER TABLE category_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE category_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON category_rules
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON category_rules TO bukuwa_app;
