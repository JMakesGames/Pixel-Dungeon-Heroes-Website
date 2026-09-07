const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- A claimed, permanent, site-wide identity. No password: whoever holds the
  -- token in their browser "is" this player. Name is unique (case-insensitive)
  -- and never changes once claimed.
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    game TEXT NOT NULL DEFAULT 'PDH2',
    description TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'single_elimination',
    max_participants INTEGER NOT NULL DEFAULT 16,
    starts_at TEXT,
    status TEXT NOT NULL DEFAULT 'signups_open', -- signups_open | in_progress | completed | cancelled
    is_official INTEGER NOT NULL DEFAULT 0, -- 1 = hosted by the site admin, counts for points/leaderboard
    host_player_id INTEGER REFERENCES players(id), -- set for community tournaments; null for official ones
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    contact TEXT NOT NULL DEFAULT '',
    seed INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tournament_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    participant1_id INTEGER REFERENCES participants(id),
    participant2_id INTEGER REFERENCES participants(id),
    winner_id INTEGER REFERENCES participants(id),
    status TEXT NOT NULL DEFAULT 'pending', -- pending | ready | done
    UNIQUE(tournament_id, round, slot)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per player per completed OFFICIAL tournament: their placement + points earned.
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    placement_tier TEXT NOT NULL, -- '1st','2nd','3rd-4th','5th-8th','9th-16th','17th-32nd','33rd-64th'
    points INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tournament_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { db, newToken };
