CREATE TABLE "ls_workorder_statuses" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"system_value" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"html_color" text,
	"archived" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ls_workorders" (
	"id" text PRIMARY KEY NOT NULL,
	"showroom_id" uuid NOT NULL,
	"status_id" integer NOT NULL,
	"customer_id" text,
	"customer_name" text DEFAULT '' NOT NULL,
	"item" text DEFAULT '' NOT NULL,
	"serial" text,
	"note" text DEFAULT '' NOT NULL,
	"hook_in" text,
	"hook_out" text,
	"employee_id" text,
	"sale_id" text,
	"time_in" timestamp with time zone,
	"eta_out" timestamp with time zone,
	"ls_updated_at" timestamp with time zone,
	"unit_id" uuid,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workorder_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ls_workorders" ADD CONSTRAINT "ls_workorders_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workorder_views" ADD CONSTRAINT "workorder_views_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ls_workorders_showroom_status_idx" ON "ls_workorders" USING btree ("showroom_id","status_id");