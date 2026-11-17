-- The pieces in a tray, in the order they went in (see trayPieces in server/table.ts), without
-- reading every piece of the jigsaw. Most pieces are in no tray, so only those that are are indexed.
CREATE INDEX IF NOT EXISTS pieces_tray ON pieces (room_id, tray, tray_at, idx) WHERE tray IS NOT NULL;
-- The private jigsaws a player has opened, for the list of jigsaws and a player's profile.
CREATE INDEX IF NOT EXISTS room_players_player ON room_players (player_id);
