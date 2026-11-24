CREATE TABLE "job_sheets" (
	"workorder_id" text PRIMARY KEY NOT NULL,
	"showroom_id" uuid NOT NULL,
	"intake" jsonb,
	"intake_by" uuid,
	"intake_at" timestamp with time zone,
	"line_notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;