const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

// In production, TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) points at a real
// Turso cloud database, so data survives host restarts/redeploys. Locally,
// with those unset, this falls back to a plain local SQLite file -- same
// client, same API, zero code differences between the two.
const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

const SCHEMA = `
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
`;

// executeMultiple() is required here, not execute() -- execute() with a
// multi-statement string silently only runs the first statement and drops
// the rest with no error, which was confirmed by hand before relying on it.
let ready = null;
function init() {
  if (!ready) {
    ready = client.execute('PRAGMA foreign_keys = ON')
      .then(() => client.executeMultiple(SCHEMA));
  }
  return ready;
}

// Thin async helpers shaped like better-sqlite3's prepare().get/all/run, so
// call sites read the same way even though everything here is a network
// round trip. lastInsertRowid comes back from libsql as a BigInt, which
// can't be JSON.stringify'd directly -- always convert to Number here so
// nothing downstream has to remember to do it.
async function dbGet(sql, args = []) {
  await init();
  const result = await client.execute({ sql, args });
  return result.rows[0] || null;
}
async function dbAll(sql, args = []) {
  await init();
  const result = await client.execute({ sql, args });
  return result.rows;
}
async function dbRun(sql, args = []) {
  await init();
  const result = await client.execute({ sql, args });
  return { lastInsertRowid: Number(result.lastInsertRowid ?? 0), changes: result.rowsAffected };
}

/** Runs `fn` against a set of transaction-scoped get/all/run helpers, committing on success and rolling back on any throw. */
async function withTransaction(fn) {
  await init();
  const tx = await client.transaction('write');
  try {
    const scoped = {
      get: async (sql, args = []) => (await tx.execute({ sql, args })).rows[0] || null,
      all: async (sql, args = []) => (await tx.execute({ sql, args })).rows,
      run: async (sql, args = []) => {
        const r = await tx.execute({ sql, args });
        return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
      },
    };
    const out = await fn(scoped);
    await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { dbGet, dbAll, dbRun, withTransaction, newToken };
