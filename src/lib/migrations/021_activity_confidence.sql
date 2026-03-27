-- Activity classification confidence + user review tracking
-- Stores the AI confidence level per activity so low-confidence items can be
-- surfaced to the user for correction via Telegram inline keyboard.
-- Note: ALTER TABLE columns are also backfilled in db.ts try-catch block for
-- upgraded installs where this migration may already have partially run.
SELECT 1; -- placeholder so transaction commits cleanly on repeat runs
