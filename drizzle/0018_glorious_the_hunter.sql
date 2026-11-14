ALTER TABLE "booking_types" ADD COLUMN "questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;