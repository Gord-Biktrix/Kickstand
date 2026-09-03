CREATE TABLE "lightspeed_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lightspeed_connections_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ls_customer_id" text;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "ls_workorder_id" text;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "ls_serialized_id" text;