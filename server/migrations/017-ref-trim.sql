-- The part of a reference image that shows, as fractions of the whole picture: left, top, width and
-- height. The whole picture by default.
ALTER TABLE refs ADD COLUMN trim_x REAL NOT NULL DEFAULT 0;
ALTER TABLE refs ADD COLUMN trim_y REAL NOT NULL DEFAULT 0;
ALTER TABLE refs ADD COLUMN trim_w REAL NOT NULL DEFAULT 1;
ALTER TABLE refs ADD COLUMN trim_h REAL NOT NULL DEFAULT 1;
