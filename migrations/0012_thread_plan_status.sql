ALTER TABLE threads
ADD COLUMN mode TEXT NOT NULL DEFAULT 'default'
  CHECK(mode IN ('default', 'plan'));

ALTER TABLE threads
ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'
  CHECK(status IN ('idle', 'working', 'waiting'));
