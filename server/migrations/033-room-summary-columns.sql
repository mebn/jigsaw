-- What the lists of jigsaws show, kept on each room instead of worked out from its pieces, times and
-- snapshots every time a list is asked for:
--   piece_count  how many pieces it has (long pieces are stored per cell, so units counts them)
--   group_count  how many groups its pieces are in: 1 when it's finished
--   seconds      the time everyone spent on it
--   played_at    when anyone was last in it (ms since epoch), 0 when not known
--   finished_at  when it was finished (ms since epoch), 0 when it isn't or that isn't known
ALTER TABLE rooms ADD COLUMN piece_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN group_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN played_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN finished_at INTEGER NOT NULL DEFAULT 0;

UPDATE rooms SET
  piece_count = CASE WHEN units > 0 THEN units ELSE (SELECT COUNT(*) FROM pieces p WHERE p.room_id = rooms.id) END,
  group_count = (SELECT COUNT(DISTINCT p.g) FROM pieces p WHERE p.room_id = rooms.id),
  seconds = (SELECT COALESCE(SUM(t.seconds), 0) FROM times t WHERE t.room_id = rooms.id),
  played_at = (SELECT COALESCE(MAX(t.seen), 0) FROM times t WHERE t.room_id = rooms.id);
-- As the list worked it out before: its last snapshot, or for one finished before snapshots, when
-- someone was last in it.
UPDATE rooms SET finished_at = COALESCE((SELECT MAX(s.t) FROM snapshots s WHERE s.room_id = rooms.id), played_at, 0)
WHERE group_count = 1;

-- A piece joining another group: the group it left may be gone, and the one it joined may be new.
CREATE TRIGGER IF NOT EXISTS pieces_group_count AFTER UPDATE OF g ON pieces WHEN OLD.g != NEW.g
BEGIN
  UPDATE rooms SET group_count = group_count
    - (NOT EXISTS (SELECT 1 FROM pieces WHERE room_id = NEW.room_id AND g = OLD.g))
    + ((SELECT COUNT(*) FROM (SELECT 1 FROM pieces WHERE room_id = NEW.room_id AND g = NEW.g LIMIT 2)) = 1)
  WHERE id = NEW.room_id;
END;

-- Down to one group: finished now.
CREATE TRIGGER IF NOT EXISTS rooms_finished AFTER UPDATE OF group_count ON rooms WHEN NEW.group_count = 1 AND OLD.group_count != 1
BEGIN
  UPDATE rooms SET finished_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;

-- Time spent and when players were last in a jigsaw add up on the jigsaw.
CREATE TRIGGER IF NOT EXISTS times_insert_room AFTER INSERT ON times
BEGIN
  UPDATE rooms SET seconds = seconds + NEW.seconds, played_at = MAX(played_at, NEW.seen) WHERE id = NEW.room_id;
END;
CREATE TRIGGER IF NOT EXISTS times_update_room AFTER UPDATE ON times
BEGIN
  UPDATE rooms SET seconds = seconds + NEW.seconds - OLD.seconds, played_at = MAX(played_at, NEW.seen) WHERE id = NEW.room_id;
END;

-- The public jigsaws in progress, most recently played or newest first; a player's own jigsaws;
-- and the time a player spent in all their jigsaws, for their stats.
CREATE INDEX IF NOT EXISTS rooms_public_played ON rooms (played_at DESC) WHERE private = 0 AND group_count != 1;
CREATE INDEX IF NOT EXISTS rooms_public_created ON rooms (created DESC) WHERE private = 0 AND group_count != 1;
CREATE INDEX IF NOT EXISTS rooms_owner ON rooms (owner);
CREATE INDEX IF NOT EXISTS times_user ON times (user);
