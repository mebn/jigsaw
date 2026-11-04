-- Reactions on notes: one row per player, note and kind ('up', 'down', 'eyes' or 'fire'). Kept when a
-- note is deleted, so undoing that brings them back; they go with the room.
CREATE TABLE IF NOT EXISTS note_reactions (
  room_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, note_id, player_id, kind)
);
