-- A jigsaw's link preview picture: a 1200x630 JPEG made by the page (see src/lib/preview.ts).
-- NULL until one is made: jigsaws from before get one the first time someone opens them.
ALTER TABLE rooms ADD COLUMN preview BLOB;
