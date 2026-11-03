-- Replies to notes, oldest first under the note's text. Kept when a note is deleted, so undoing that
-- brings them back; they go with the room.
CREATE TABLE IF NOT EXISTS note_replies (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, id)
);
