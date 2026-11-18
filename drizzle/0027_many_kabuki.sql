CREATE TABLE "job_trackers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"workorder_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"told_status" text,
	"told_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_trackers" ADD CONSTRAINT "job_trackers_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_trackers_token_idx" ON "job_trackers" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "job_trackers_workorder_idx" ON "job_trackers" USING btree ("workorder_id");