-- Rebuild node_task_links after focus_sessions was removed in migration 019.
--
-- The original table referenced focus_sessions(id). After focus_sessions is
-- dropped, SQLite can throw "no such table: main.focus_sessions" when deleting
-- or updating graph rows. Keep study_session_id as a legacy nullable value, but
-- remove the stale foreign key.

DROP TABLE IF EXISTS node_task_links_v037;

CREATE TABLE IF NOT EXISTS node_task_links_v037 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  study_session_id INTEGER,
  contribution REAL NOT NULL DEFAULT 0.4 CHECK(contribution > 0.0 AND contribution <= 1.0)
);

INSERT INTO node_task_links_v037 (id, node_id, task_id, study_session_id, contribution)
SELECT id, node_id, task_id, study_session_id, contribution
FROM node_task_links;

DROP TABLE node_task_links;

ALTER TABLE node_task_links_v037 RENAME TO node_task_links;
