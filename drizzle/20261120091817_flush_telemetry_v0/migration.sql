TRUNCATE TABLE "telemetry_v0";--> statement-breakpoint
ALTER TABLE "telemetry_v0" ADD COLUMN "esp_temperature" real;--> statement-breakpoint
ALTER TABLE "telemetry_v0" DROP COLUMN "pressure";--> statement-breakpoint
ALTER TABLE "telemetry_v0" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "telemetry_v0" ALTER COLUMN "methane_raw" SET DATA TYPE real USING "methane_raw"::real;