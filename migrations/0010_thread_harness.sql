ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'codex' CHECK(harness IN ('codex', 'claude'));
