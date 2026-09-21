-- Calendar sync refreshes `synced_at` for every mirrored row so it can purge
-- events missing from the current batch. That bookkeeping is not a user-visible
-- domain change and must not force every open LifeOS tab to reload.
DROP TRIGGER IF EXISTS domain_revision_calendar_events_au;

CREATE TRIGGER domain_revision_calendar_events_au
AFTER UPDATE ON calendar_events
WHEN OLD.title IS NOT NEW.title
  OR OLD.description IS NOT NEW.description
  OR OLD.start_time IS NOT NEW.start_time
  OR OLD.end_time IS NOT NEW.end_time
  OR OLD.location IS NOT NEW.location
BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
