-- The forge wall: visitors' questions and ideas, and what became of them.
--
-- Apply once:  npx wrangler d1 execute cunningclaw-wall --remote --file=./functions/_wall/schema.sql
-- Every statement is IF NOT EXISTS, so running it twice changes nothing.
--
-- What is NOT here is the point. No email, no IP address, no user agent, no
-- account. A card is the words, an optional first name or handle, and dates
-- to the day. The two hashed columns are keyed HMACs of the visitor's address
-- (see wall.js): `votes.voter` is per card, so one vote cannot be linked to
-- another, and `hits.visitor` changes every UTC day and is deleted within two.

CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('question', 'idea')),
  body        TEXT    NOT NULL,
  name        TEXT,
  -- pending: nobody but the team sees it. public: on the wall. hidden: taken down.
  moderation  TEXT    NOT NULL DEFAULT 'pending' CHECK (moderation IN ('pending', 'public', 'hidden')),
  -- the journey a visitor watches: asked → answered → planned → built
  stage       TEXT    NOT NULL DEFAULT 'asked' CHECK (stage IN ('asked', 'answered', 'planned', 'built')),
  answer      TEXT,
  link        TEXT,
  votes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  answered_at INTEGER,
  planned_at  INTEGER,
  built_at    INTEGER
);
CREATE INDEX IF NOT EXISTS cards_by_moderation ON cards (moderation, updated_at);

CREATE TABLE IF NOT EXISTS votes (
  card_id INTEGER NOT NULL,
  voter   TEXT    NOT NULL,
  PRIMARY KEY (card_id, voter)
);

CREATE TABLE IF NOT EXISTS hits (
  visitor TEXT    NOT NULL,
  action  TEXT    NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hits_by_visitor ON hits (visitor, action, at);
