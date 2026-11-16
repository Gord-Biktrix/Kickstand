CREATE TABLE "ls_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price" numeric(10, 2),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
