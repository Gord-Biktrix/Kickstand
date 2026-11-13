-- Custom SQL migration file, put your code below! ---- Shop floor brand (2026-11): test rides take the orange, service moves to amber. Only the untouched defaults.
UPDATE "booking_types" SET "color" = 'amber' WHERE "slug" = 'service' AND "color" = 'orange';--> statement-breakpoint
UPDATE "booking_types" SET "color" = 'orange' WHERE "slug" = 'test-ride' AND "color" = 'blue';
