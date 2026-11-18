CREATE TABLE "finding_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"workorder_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"sent_by" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"told_status" text
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"workorder_id" text NOT NULL,
	"request_id" uuid,
	"level" smallint NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"items" jsonb NOT NULL,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"ls_added" boolean DEFAULT false NOT NULL,
	"ls_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_level_check" CHECK ("findings"."level" between 1 and 3),
	CONSTRAINT "findings_decision_check" CHECK ("findings"."decision" is null or "findings"."decision" in ('approved','declined','not_asked'))
);
--> statement-breakpoint
ALTER TABLE "finding_requests" ADD CONSTRAINT "finding_requests_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_request_id_finding_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."finding_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_requests_token_idx" ON "finding_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "finding_requests_workorder_idx" ON "finding_requests" USING btree ("workorder_id");--> statement-breakpoint
CREATE INDEX "findings_workorder_idx" ON "findings" USING btree ("workorder_id");