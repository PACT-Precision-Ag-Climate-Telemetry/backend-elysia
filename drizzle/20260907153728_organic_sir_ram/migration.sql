ALTER TABLE "organization" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "organization_deletedAt_idx" ON "organization" ("deleted_at");