ALTER TABLE threads
  ADD COLUMN fork_base_token_usage_json TEXT NOT NULL DEFAULT '{}';
