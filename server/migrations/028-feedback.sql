-- What players write in the feedback dialog (Settings > General), to read straight from the database.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL DEFAULT 0,
  player_id TEXT,
  room_id TEXT,
  text TEXT NOT NULL DEFAULT ''
);
