CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"cancelled_reason" text,
	"replaced_by" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" in ('booked','completed','no_show','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "capacity_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"capacity" smallint NOT NULL,
	"window_start" time,
	"window_end" time,
	"max_concurrent" smallint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_overrides_showroom_date" UNIQUE("showroom_id","on_date"),
	CONSTRAINT "capacity_overrides_capacity_check" CHECK ("capacity_overrides"."capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capacity_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"capacity" smallint NOT NULL,
	"window_start" time NOT NULL,
	"window_end" time NOT NULL,
	"max_concurrent" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_rules_showroom_weekday" UNIQUE("showroom_id","weekday"),
	CONSTRAINT "capacity_rules_weekday_check" CHECK ("capacity_rules"."weekday" between 0 and 6),
	CONSTRAINT "capacity_rules_capacity_check" CHECK ("capacity_rules"."capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "day_counters" (
	"showroom_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"booked_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "day_counters_showroom_id_on_date_pk" PRIMARY KEY("showroom_id","on_date")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"unit_id" uuid,
	"order_id" uuid,
	"appointment_id" uuid,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"klaviyo_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"source" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"size" text,
	"colour" text,
	"order_date" date NOT NULL,
	"payment_status" text NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"terms_version" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"deferred_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_showroom_source_ref" UNIQUE("showroom_id","source","order_ref"),
	CONSTRAINT "orders_source_check" CHECK ("orders"."source" in ('lightspeed','shopify','manual')),
	CONSTRAINT "orders_payment_status_check" CHECK ("orders"."payment_status" in ('paid','deposit')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('open','deferred','fulfilled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "showrooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"address_line" text NOT NULL,
	"phone" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showrooms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"showroom_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_users_role_check" CHECK ("staff_users"."role" in ('staff','manager','admin'))
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"order_id" uuid,
	"box_tag" text NOT NULL,
	"model" text NOT NULL,
	"size" text,
	"colour" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"invited_at" timestamp with time zone,
	"book_by" timestamp with time zone,
	"pickup_by" timestamp with time zone,
	"extension_count" smallint DEFAULT 0 NOT NULL,
	"no_show_count" smallint DEFAULT 0 NOT NULL,
	"storage_from" timestamp with time zone,
	"storage_collected_cents" integer,
	"storage_waived_cents" integer,
	"early_bird" boolean DEFAULT false NOT NULL,
	"token_hash" text,
	"token_enc" text,
	"picked_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "units_showroom_box_tag" UNIQUE("showroom_id","box_tag"),
	CONSTRAINT "units_status_check" CHECK ("units"."status" in ('received','invited','booked','building','ready','picked_up','unassigned'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_overrides" ADD CONSTRAINT "capacity_overrides_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_rules" ADD CONSTRAINT "capacity_rules_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_counters" ADD CONSTRAINT "day_counters_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_day_booked" ON "appointments" USING btree ("showroom_id","on_date") WHERE status = 'booked';--> statement-breakpoint
CREATE INDEX "appointments_unit_booked" ON "appointments" USING btree ("unit_id") WHERE status = 'booked';--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe" ON "events" USING btree ("unit_id","type",("payload"->>'dedupe_key'));--> statement-breakpoint
CREATE INDEX "events_unit_created" ON "events" USING btree ("unit_id","created_at");--> statement-breakpoint
CREATE INDEX "events_order_created" ON "events" USING btree ("order_id","created_at");