ALTER TABLE "staff_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "password_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "password_locked_until" timestamp with time zone;