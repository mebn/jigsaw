-- A jigsaw's pictures (the picture itself, its thumbnail as a data URL and its link preview) move
-- to a table of their own. In rooms they sat in the middle of each row, so every look at the
-- columns after them (owner, private, units...) for the list of jigsaws or opening one read
-- through the whole picture first. Their old columns in rooms stay, emptied (image_type stays as
-- it is, being small).
-- has_thumb and has_preview say whether a jigsaw has those, without reading them.
CREATE TABLE IF NOT EXISTS room_pictures (
  room_id TEXT PRIMARY KEY,
  image BLOB NOT NULL,
  thumb TEXT NOT NULL DEFAULT '',
  preview BLOB
);
INSERT OR IGNORE INTO room_pictures (room_id, image, thumb, preview) SELECT id, image, thumb, preview FROM rooms;

ALTER TABLE rooms ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN has_preview INTEGER NOT NULL DEFAULT 0;
UPDATE rooms SET has_thumb = length(thumb) > 0, has_preview = preview IS NOT NULL, image = x'', thumb = '', preview = NULL;
