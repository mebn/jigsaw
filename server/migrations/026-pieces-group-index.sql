-- Counting a group's pieces, and a jigsaw's groups, without reading every piece of the jigsaw: done
-- on every move (see snapshot() in server/table.ts) and for the list of jigsaws.
CREATE INDEX IF NOT EXISTS pieces_group ON pieces (room_id, g);
