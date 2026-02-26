-- Tab Group (Workspace) Tracking
-- Adds workspace context to activity records for project-level analytics

ALTER TABLE activities ADD COLUMN tab_group_id INTEGER DEFAULT -1;
ALTER TABLE activities ADD COLUMN tab_group_title TEXT DEFAULT NULL;
ALTER TABLE activities ADD COLUMN tab_group_color TEXT DEFAULT NULL;
