-- Which tray each piece is in is kept on the piece, saved with its moves, so two players changing
-- the same tray at once no longer overwrite each other's list. tray is the tray's id (null: none),
-- tray_at when the piece was put in it (ms), for sorting a tray in the order its pieces came in.
-- trays.pieces is no longer used, and stays for now so an older build can still be run.
ALTER TABLE pieces ADD COLUMN tray TEXT;
ALTER TABLE pieces ADD COLUMN tray_at INTEGER NOT NULL DEFAULT 0;

-- Filled in from the trays' lists. A piece in more than one list goes in the newest tray. The order
-- within a tray is kept by counting up from when the tray was made.
UPDATE pieces SET tray = (
  SELECT t.id FROM trays t, json_each(t.pieces) j
  WHERE t.room_id = pieces.room_id AND j.value = pieces.idx
  ORDER BY t.created DESC, t.id DESC LIMIT 1
)
WHERE room_id IN (SELECT room_id FROM trays WHERE pieces != '[]');

UPDATE pieces SET tray_at = (
  SELECT t.created + j.key FROM trays t, json_each(t.pieces) j
  WHERE t.room_id = pieces.room_id AND t.id = pieces.tray AND j.value = pieces.idx
  LIMIT 1
)
WHERE tray IS NOT NULL;
