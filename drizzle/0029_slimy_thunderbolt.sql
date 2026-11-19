ALTER TABLE "booking_types" ADD COLUMN "in_directory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "showrooms" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "showrooms" ADD COLUMN "lng" double precision;--> statement-breakpoint
-- Where the Biktrix showrooms are (their cities), for "closest to you" in the directory. No-op where these slugs don't exist.
UPDATE "showrooms" SET "lat" = v.lat, "lng" = v.lng FROM (VALUES ('calgary', 50.95, -114.07), ('edmonton', 53.54, -113.49), ('kelowna', 49.88, -119.47), ('saskatoon', 52.12, -106.66), ('vancouver', 49.26, -123.04), ('victoria', 48.44, -123.37)) AS v(slug, lat, lng) WHERE "showrooms"."slug" = v.slug;
