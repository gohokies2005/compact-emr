-- Clean up existing veteran names that came in ALL-CAPS (or lower-case) from intake forms — e.g.
-- "WOODLEY, TRAVIS" → "Woodley, Travis". initcap() title-cases: first letter of each word up, rest
-- down, and capitalizes after spaces/hyphens/apostrophes (Hamilton-Dorsey, O'Brien). Ryan 2026-06-05.
-- New veterans are normalized on create (toTitleCaseName in veteran-validation.ts).
UPDATE "veterans" SET "first_name" = initcap("first_name") WHERE "first_name" IS NOT NULL;
UPDATE "veterans" SET "last_name" = initcap("last_name") WHERE "last_name" IS NOT NULL;
