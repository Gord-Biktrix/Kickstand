CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_preview" text DEFAULT '' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_showroom_phone" UNIQUE("showroom_id","phone")
);
--> statement-breakpoint
CREATE TABLE "chat_lines" (
	"showroom_id" uuid PRIMARY KEY NOT NULL,
	"number" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"number_state" text DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_lines_state_check" CHECK ("chat_lines"."number_state" in ('not_started','porting','hosted','live'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"showroom_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"auto_tag" text,
	"body" text DEFAULT '' NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"twilio_sid" text,
	"status" text NOT NULL,
	"error_code" text,
	"error" text,
	"staff_user_id" uuid,
	"staff_name" text,
	"segments" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_direction_check" CHECK ("chat_messages"."direction" in ('in','out')),
	CONSTRAINT "chat_messages_kind_check" CHECK ("chat_messages"."kind" in ('manual','auto'))
);
--> statement-breakpoint
CREATE TABLE "chat_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_id" uuid NOT NULL,
	"token" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"image" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_photos_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_lines" ADD CONSTRAINT "chat_lines_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_recent_idx" ON "chat_conversations" USING btree ("showroom_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_lines_number_idx" ON "chat_lines" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_sid_idx" ON "chat_messages" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_idx" ON "chat_messages" USING btree ("conversation_id","created_at");