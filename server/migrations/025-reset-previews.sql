-- Link previews are now the picture cropped to fill them, not the picture over a blurred copy of it.
-- The ones made so far are dropped, and each jigsaw makes a new one the next time it's opened.
UPDATE rooms SET preview = NULL;
