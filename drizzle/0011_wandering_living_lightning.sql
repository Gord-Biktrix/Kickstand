CREATE TABLE "booking_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"access" text DEFAULT 'public' NOT NULL,
	"location" text DEFAULT 'in_person' NOT NULL,
	"duration_min" smallint DEFAULT 30 NOT NULL,
	"buffer_min" smallint DEFAULT 0 NOT NULL,
	"slot_step_min" smallint DEFAULT 30 NOT NULL,
	"notice_min" integer DEFAULT 240 NOT NULL,
	"horizon_days" smallint DEFAULT 60 NOT NULL,
	"capacity_mode" text DEFAULT 'bench' NOT NULL,
	"bench_capacity" smallint DEFAULT 1 NOT NULL,
	"hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creates_work_order" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_types_showroom_slug" UNIQUE("showroom_id","slug"),
	CONSTRAINT "booking_types_kind_check" CHECK ("booking_types"."kind" in ('standard','pickup')),
	CONSTRAINT "booking_types_access_check" CHECK ("booking_types"."access" in ('public','invite')),
	CONSTRAINT "booking_types_location_check" CHECK ("booking_types"."location" in ('in_person','video','phone')),
	CONSTRAINT "booking_types_capacity_mode_check" CHECK ("booking_types"."capacity_mode" in ('bench','staff')),
	CONSTRAINT "booking_types_numbers_check" CHECK ("booking_types"."duration_min" between 5 and 480 and "booking_types"."buffer_min" between 0 and 240 and "booking_types"."slot_step_min" between 5 and 240 and "booking_types"."notice_min" >= 0 and "booking_types"."horizon_days" between 1 and 365 and "booking_types"."bench_capacity" between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "showrooms" ADD COLUMN "kind" text DEFAULT 'showroom' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "extra_showroom_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_types" ADD CONSTRAINT "booking_types_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showrooms" ADD CONSTRAINT "showrooms_kind_check" CHECK ("showrooms"."kind" in ('showroom','online'));--> statement-breakpoint
INSERT INTO "booking_types" ("showroom_id", "slug", "name", "description", "kind", "access", "location", "notice_min", "sort_order") SELECT "id", 'pickup', 'Bike pickup', 'Collect your new bike. Booked from the link we send when it arrives.', 'pickup', 'invite', 'in_person', 0, 0 FROM "showrooms" WHERE "kind" = 'showroom' ON CONFLICT DO NOTHING;
