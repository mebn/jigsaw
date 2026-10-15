-- The biggest group of pieces each time it grew, for a timelapse of the jigsaw being put together.
-- t: when (ms); size: how many cells were in it; pieces: which, one bit per cell (bit i % 8 of byte
-- i / 8). Jigsaws started before this only have snapshots from when it shipped.
CREATE TABLE IF NOT EXISTS snapshots (
  room_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  size INTEGER NOT NULL,
  pieces BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_room ON snapshots (room_id, t);
