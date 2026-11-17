CREATE TABLE "job_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"workorder_id" text NOT NULL,
	"kind" text NOT NULL,
	"step" text,
	"task_key" text,
	"task_label" text,
	"reason" text,
	"total" integer,
	"actor" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_log_kind_check" CHECK ("job_log"."kind" in ('step','task_done','task_undone','task_skipped','pause','resume','tasks'))
);
--> statement-breakpoint
ALTER TABLE "job_log" ADD CONSTRAINT "job_log_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_log_workorder_idx" ON "job_log" USING btree ("workorder_id","at");--> statement-breakpoint
CREATE INDEX "job_log_actor_idx" ON "job_log" USING btree ("actor","at");