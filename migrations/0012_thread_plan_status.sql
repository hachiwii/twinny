ALTER TABLE threads
ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'
  CHECK(status IN ('idle', 'working', 'waiting'));
