ALTER TABLE "appointments" ADD COLUMN "group_id" uuid;--> statement-breakpoint
CREATE INDEX "appointments_group" ON "appointments" USING btree ("group_id") WHERE group_id is not null;