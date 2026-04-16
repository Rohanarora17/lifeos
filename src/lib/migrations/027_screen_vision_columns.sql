-- Screen vision columns for screen_observations table
-- Adds structured fields produced by the session-aware Gemini Vision analysis

ALTER TABLE screen_observations ADD COLUMN task_alignment REAL;
ALTER TABLE screen_observations ADD COLUMN engagement_depth TEXT;
ALTER TABLE screen_observations ADD COLUMN distraction_indicators TEXT; -- JSON array
ALTER TABLE screen_observations ADD COLUMN progress_indicator TEXT;
ALTER TABLE screen_observations ADD COLUMN change_magnitude TEXT; -- 'none'|'minor'|'moderate'|'major'
ALTER TABLE screen_observations ADD COLUMN window_title TEXT;
