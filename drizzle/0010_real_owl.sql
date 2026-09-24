ALTER TABLE "orders" ADD COLUMN "pickup_group" uuid;--> statement-breakpoint
CREATE INDEX "orders_pickup_group" ON "orders" USING btree ("pickup_group") WHERE pickup_group is not null;