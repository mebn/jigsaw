-- A player's profile picture: a small square picture, its type, and when it was set (0: none), which
-- pages use to know when to load it again.
ALTER TABLE players ADD COLUMN avatar BLOB;
ALTER TABLE players ADD COLUMN avatar_type TEXT;
ALTER TABLE players ADD COLUMN avatar_at INTEGER NOT NULL DEFAULT 0;
