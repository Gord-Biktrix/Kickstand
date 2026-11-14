-- Shop floor brand (2026-11): orange is the default visit-type colour, not blue. Types still on the old blue default become orange.
UPDATE "booking_types" SET "color" = 'orange' WHERE "color" = 'blue';
