-- Foreground media playback is verified browser evidence even when the user is
-- not generating keyboard or mouse input. This prevents an advancing lecture
-- video from being mislabeled as system idle.

ALTER TABLE browser_collector_status ADD COLUMN media_playback_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_collector_status ADD COLUMN media_title TEXT;
