ALTER TABLE "bookings" ADD COLUMN "google_event_id" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "google_calendar_id" text;--> statement-breakpoint
ALTER TABLE "showrooms" ADD COLUMN "google_calendar_id" text;