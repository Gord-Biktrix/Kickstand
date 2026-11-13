ALTER TABLE "booking_types" ADD COLUMN "use_store_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_types" ADD COLUMN "color" text DEFAULT 'blue' NOT NULL;--> statement-breakpoint
ALTER TABLE "showrooms" ADD COLUMN "booking_hours" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "showrooms" s SET "booking_hours" = COALESCE((SELECT jsonb_object_agg(r."weekday"::text, jsonb_build_array(jsonb_build_array(to_char(r."window_start", 'HH24:MI'), to_char(r."window_end", 'HH24:MI')))) FROM "capacity_rules" r WHERE r."showroom_id" = s."id" AND r."capacity" > 0), '{}'::jsonb) WHERE s."kind" = 'showroom';
--> statement-breakpoint
UPDATE "showrooms" SET "booking_hours" = '{"1":[["08:00","16:00"]],"2":[["08:00","16:00"]],"3":[["08:00","16:00"]],"4":[["08:00","16:00"]],"5":[["08:00","16:00"]]}'::jsonb WHERE "kind" = 'online' OR "booking_hours" = '{}'::jsonb;
--> statement-breakpoint
UPDATE "booking_types" t SET "use_store_hours" = true FROM "showrooms" s WHERE t."showroom_id" = s."id" AND t."kind" = 'standard' AND t."hours" = s."booking_hours";
--> statement-breakpoint
UPDATE "booking_types" SET "color" = CASE "slug" WHEN 'service' THEN 'orange' WHEN 'showroom-visit' THEN 'green' WHEN 'video-call' THEN 'purple' WHEN 'phone-call' THEN 'teal' WHEN 'pickup' THEN 'slate' ELSE 'blue' END;
