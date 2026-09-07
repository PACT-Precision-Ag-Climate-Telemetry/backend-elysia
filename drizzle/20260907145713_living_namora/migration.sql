CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TABLE "farm_field" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"area" geometry(Polygon,4326) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "farm_field_id" text;--> statement-breakpoint
CREATE INDEX "device_farmFieldId_idx" ON "device" ("farm_field_id");--> statement-breakpoint
CREATE INDEX "farm_field_organizationId_idx" ON "farm_field" ("organization_id");--> statement-breakpoint
CREATE INDEX "farm_field_deletedAt_idx" ON "farm_field" ("deleted_at");--> statement-breakpoint
CREATE INDEX "farm_field_area_idx" ON "farm_field" USING gist ("area");--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_farm_field_id_farm_field_id_fkey" FOREIGN KEY ("farm_field_id") REFERENCES "farm_field"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "farm_field" ADD CONSTRAINT "farm_field_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;