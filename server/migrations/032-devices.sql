-- The browsers each player signs up or logs in from: one row per player, address and browser, kept
-- up to date on every visit (see server/devices.ts).
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  mobile INTEGER NOT NULL DEFAULT 0,
  -- An app's own browser (Instagram, Messenger, an Android web view), which often forgets logins.
  in_app TEXT NOT NULL DEFAULT '',
  -- What the page found: 'persisted', 'ok' or 'blocked' (localStorage can't be written).
  storage TEXT NOT NULL DEFAULT '',
  -- Screen size in CSS pixels and the pixel ratio, as 390x844@3.
  screen TEXT NOT NULL DEFAULT '',
  webgpu INTEGER,
  -- How it got here the first time: signup, claim, login, email-login or email.
  first_action TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_key ON devices (player_id, ip, user_agent);
CREATE INDEX IF NOT EXISTS devices_ip ON devices (ip);
