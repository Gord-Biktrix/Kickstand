CREATE TABLE "ls_employees" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
