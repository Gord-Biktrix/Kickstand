ALTER TABLE "orders" ADD COLUMN "kind" text DEFAULT 'bike' NOT NULL;--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "kind" text DEFAULT 'bike' NOT NULL;