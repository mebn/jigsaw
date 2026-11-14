-- A player's score in a jigsaw: how many connections they made, one for every join of two pieces
-- or groups (see saveMoves() in server/table.ts).
CREATE TABLE IF NOT EXISTS scores (
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, player_id)
);
CREATE INDEX IF NOT EXISTS scores_player ON scores (player_id);

-- Everyone starts from the score they had: the pieces they were credited with. Long pieces are
-- stored per cell, so those are scaled down to whole pieces.
INSERT OR IGNORE INTO scores (room_id, player_id, n)
SELECT p.room_id, p."by",
       CASE WHEN r.units > 0
            THEN CAST(ROUND(COUNT(*) * 1.0 * r.units / (SELECT COUNT(*) FROM pieces a WHERE a.room_id = p.room_id)) AS INTEGER)
            ELSE COUNT(*) END
FROM pieces p JOIN rooms r ON r.id = p.room_id
WHERE p."by" IS NOT NULL AND p."by" != ''
GROUP BY p.room_id, p."by";
