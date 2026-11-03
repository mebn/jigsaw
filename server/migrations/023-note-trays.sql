-- The tray a note is stuck to, on its bottom right corner, so it moves with the tray. NULL: none.
ALTER TABLE notes ADD COLUMN tray TEXT;
