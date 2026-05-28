ALTER TABLE threads
  ADD COLUMN fork_source TEXT CHECK(fork_source IS NULL OR fork_source IN ('external_resume'));
