CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"booking_type_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"customer_note" text DEFAULT '' NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"cancelled_reason" text,
	"reschedule_count" smallint DEFAULT 0 NOT NULL,
	"ls_workorder_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" in ('booked','completed','no_show','cancelled')),
	CONSTRAINT "bookings_contact_check" CHECK ("bookings"."customer_email" is not null or "bookings"."customer_phone" is not null)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booking_type_id_booking_types_id_fk" FOREIGN KEY ("booking_type_id") REFERENCES "public"."booking_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_day_booked" ON "bookings" USING btree ("showroom_id","on_date") WHERE status = 'booked';--> statement-breakpoint
CREATE INDEX "bookings_type_booked" ON "bookings" USING btree ("booking_type_id","starts_at") WHERE status = 'booked';