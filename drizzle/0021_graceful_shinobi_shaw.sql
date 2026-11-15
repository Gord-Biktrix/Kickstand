CREATE TABLE "staff_photos" (
	"staff_user_id" uuid PRIMARY KEY NOT NULL,
	"image" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_types" ADD COLUMN "host_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_photos" ADD CONSTRAINT "staff_photos_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;