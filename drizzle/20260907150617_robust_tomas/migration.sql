ALTER TABLE "organization" ADD COLUMN "area" geometry(MultiPolygon,4326);--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "area_source" text;--> statement-breakpoint
CREATE INDEX "organization_parentOrgId_idx" ON "organization" ("parent_org_id");--> statement-breakpoint
CREATE INDEX "organization_area_idx" ON "organization" USING gist ("area");