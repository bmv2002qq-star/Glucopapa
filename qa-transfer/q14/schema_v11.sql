-- Q14 candidate only. Do not install in a production DB before Android and backup verification.
-- Extend existing receipt and change-feed namespace so legacy writers cannot reuse a COB key.
ALTER TABLE v3_extended_receipts RENAME TO q14_old_extended_receipts;
CREATE TABLE v3_extended_receipts (
 idempotency_key TEXT PRIMARY KEY,
 profile_id TEXT NOT NULL,
 domain TEXT NOT NULL CHECK(domain IN ('mealSessions','conditionPeriods','settings','mealTiming','syncInbox','mealAbsorption')),
 record_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 source_module TEXT NOT NULL
);
INSERT INTO v3_extended_receipts SELECT * FROM q14_old_extended_receipts;
DROP TABLE q14_old_extended_receipts;
ALTER TABLE v3_extended_change_feed RENAME TO q14_old_extended_change_feed;
CREATE TABLE v3_extended_change_feed (
 revision INTEGER PRIMARY KEY CHECK(revision>0),
 domain TEXT NOT NULL CHECK(domain IN ('mealSessions','conditionPeriods','settings','mealTiming','syncInbox','mealAbsorption')),
 record_id TEXT NOT NULL,
 created_at_utc TEXT NOT NULL,
 source_module TEXT NOT NULL
);
INSERT INTO v3_extended_change_feed SELECT * FROM q14_old_extended_change_feed;
DROP TABLE q14_old_extended_change_feed;
-- Initial diagnostic-only storage. No numeric clinical result can be written by this schema.
CREATE TABLE v3_meal_absorption (
 publication_id TEXT PRIMARY KEY NOT NULL,
 profile_id TEXT NOT NULL,
 model_id TEXT NOT NULL CHECK(model_id IN ('GFForecast','GFCOB')),
 model_version TEXT NOT NULL CHECK(length(model_version) BETWEEN 1 AND 80),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 computed_at_utc TEXT NOT NULL,
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
 result_status TEXT NOT NULL CHECK(result_status IN ('UNKNOWN','STALE')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('PARAMETERS_UNVALIDATED','SOURCE_INCOMPLETE','CONTEXT_CHANGED')),
 cob_g REAL CHECK(cob_g IS NULL),
 created_revision INTEGER NOT NULL UNIQUE CHECK(created_revision>source_revision),
 source_module TEXT NOT NULL CHECK(source_module='GFMealAbsorption')
);
CREATE INDEX idx_v3_absorption_profile_revision ON v3_meal_absorption(profile_id,source_revision,created_revision);
