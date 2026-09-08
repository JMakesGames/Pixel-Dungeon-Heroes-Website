const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { dbGet, dbAll, dbRun, newToken } = require('./db');
const { generateBracket, setMatchWinner } = require('./bracket');

// Minimal .env loader — avoids pulling in a dependency just for this. Only
// sets variables that aren't already set (so real env vars, e.g. on Render,
// always win over the local file).
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

const PORT = process.env.PORT || 3210;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!ADMIN_PASSWORD) {
  console.warn('[tournaments] WARNING: ADMIN_PASSWORD is not set — using dev default "changeme". Set a real ADMIN_PASSWORD env var before deploying.');
}
const effectivePassword = ADMIN_PASSWORD || 'changeme';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

app.use(express.json());

// The DB client is a network call now (Turso), not a local synchronous file,
// so every route below is async. Express 4 does NOT automatically catch a
// rejected promise from an async handler the way Express 5 does — an
// uncaught one would just hang the request forever instead of erroring
// cleanly. `wrap` catches that and turns it into a normal 500.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- tiny cookie helpers (no extra dependency needed for this) ---
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; Max-Age=0`);
}

async function isAdminRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token) return false;
  const session = await dbGet('SELECT * FROM admin_sessions WHERE token = ?', [token]);
  return !!(session && session.expires_at > Date.now());
}
function requireAdmin(req, res, next) {
  isAdminRequest(req).then(ok => {
    if (!ok) return res.status(401).json({ error: 'Not logged in' });
    next();
  }).catch(next);
}

// ===================== PLAYER IDENTITY =====================
// A claimed name is permanent and unique (case-insensitive) site-wide. No
// password — whoever holds the token (saved in the browser's localStorage)
// "is" that player. This is intentionally lightweight: see project notes on
// the tradeoff (lose your browser storage, lose access to the name).
async function getPlayerFromRequest(req) {
  const token = req.headers['x-player-token'];
  if (!token || typeof token !== 'string') return null;
  return (await dbGet('SELECT * FROM players WHERE token = ?', [token])) || null;
}
function requirePlayer(req, res, next) {
  getPlayerFromRequest(req).then(player => {
    if (!player) return res.status(401).json({ error: 'Claim a name first' });
    req.player = player;
    next();
  }).catch(next);
}

app.post('/api/players/claim', wrap(async (req, res) => {
  let { name } = req.body || {};
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  const nameLower = name.toLowerCase();

  const existing = await dbGet('SELECT id FROM players WHERE name_lower = ?', [nameLower]);
  if (existing) return res.status(409).json({ error: 'That name is already taken. Pick another.' });

  const token = newToken();
  try {
    const info = await dbRun('INSERT INTO players (name, name_lower, token) VALUES (?, ?, ?)', [name, nameLower, token]);
    res.json({ id: info.lastInsertRowid, name, token });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That name is already taken. Pick another.' });
    throw err;
  }
}));

app.get('/api/players/me', wrap(async (req, res) => {
  const player = await getPlayerFromRequest(req);
  if (!player) return res.status(401).json({ error: 'No identity' });
  res.json({ id: player.id, name: player.name });
}));

// ===================== PUBLIC READS =====================
async function tournamentSummary(t) {
  const count = (await dbGet('SELECT COUNT(*) AS n FROM participants WHERE tournament_id = ?', [t.id])).n;
  const host = t.host_player_id ? await dbGet('SELECT name FROM players WHERE id = ?', [t.host_player_id]) : null;
  return { ...t, participant_count: count, host_name: host ? host.name : null };
}

app.get('/api/tournaments', wrap(async (req, res) => {
  const rows = await dbAll('SELECT * FROM tournaments ORDER BY datetime(created_at) DESC');
  res.json(await Promise.all(rows.map(tournamentSummary)));
}));

app.get('/api/tournaments/:id', wrap(async (req, res) => {
  const t = await dbGet('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const participants = await dbAll(`
    SELECT p.id, p.player_id, pl.name AS display_name, p.seed
    FROM participants p JOIN players pl ON pl.id = p.player_id
    WHERE p.tournament_id = ? ORDER BY p.id
  `, [t.id]);
  const matches = await dbAll(
    'SELECT id, round, slot, participant1_id, participant2_id, winner_id, status FROM matches WHERE tournament_id = ? ORDER BY round, slot',
    [t.id]
  );
  res.json({ ...(await tournamentSummary(t)), participants, matches });
}));

app.get('/api/tournaments/:id/me', requirePlayer, wrap(async (req, res) => {
  const row = await dbGet(
    'SELECT id FROM participants WHERE tournament_id = ? AND player_id = ?',
    [req.params.id, req.player.id]
  );
  res.json({ registered: !!row });
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  const rows = await dbAll(`
    SELECT pl.id, pl.name,
      COALESCE(SUM(r.points), 0) AS total_points,
      COUNT(CASE WHEN r.placement_tier = '1st' THEN 1 END) AS wins,
      COUNT(r.id) AS tournaments_placed
    FROM players pl
    JOIN results r ON r.player_id = pl.id
    GROUP BY pl.id
    HAVING total_points > 0
    ORDER BY total_points DESC, wins DESC, pl.name COLLATE NOCASE ASC
    LIMIT 200
  `);
  res.json(rows);
}));

// ===================== SIGNUP =====================
app.post('/api/tournaments/:id/signup', requirePlayer, wrap(async (req, res) => {
  const t = await dbGet('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  if (t.status !== 'signups_open') return res.status(400).json({ error: 'Signups are closed for this tournament' });

  const count = (await dbGet('SELECT COUNT(*) AS n FROM participants WHERE tournament_id = ?', [t.id])).n;
  if (count >= t.max_participants) return res.status(400).json({ error: 'Tournament is full' });

  const already = await dbGet('SELECT id FROM participants WHERE tournament_id = ? AND player_id = ?', [t.id, req.player.id]);
  if (already) return res.status(400).json({ error: "You're already signed up for this tournament" });

  const contact = String((req.body || {}).contact || '').trim().slice(0, 120);
  const info = await dbRun('INSERT INTO participants (tournament_id, player_id, contact) VALUES (?, ?, ?)', [t.id, req.player.id, contact]);

  req.app.get('io').to(`tournament:${t.id}`).emit('roster:update');
  res.json({ id: info.lastInsertRowid, display_name: req.player.name });
}));

// ===================== TOURNAMENT CREATION =====================
function buildTournamentFromBody(body) {
  let { name, game, description, max_participants, starts_at } = body || {};
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new Error('Name is required');
  game = (game === 'PDH1' ? 'PDH1' : 'PDH2');
  description = String(description || '').trim().slice(0, 2000);
  max_participants = Math.max(2, Math.min(64, parseInt(max_participants, 10) || 16));
  starts_at = starts_at ? String(starts_at).slice(0, 40) : null;
  return { name, game, description, max_participants, starts_at };
}

// Official tournaments — admin only.
app.post('/api/admin/tournaments', requireAdmin, wrap(async (req, res) => {
  let fields;
  try { fields = buildTournamentFromBody(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const info = await dbRun(`
    INSERT INTO tournaments (name, game, description, format, max_participants, starts_at, status, is_official, host_player_id)
    VALUES (?, ?, ?, 'single_elimination', ?, ?, 'signups_open', 1, NULL)
  `, [fields.name, fields.game, fields.description, fields.max_participants, fields.starts_at]);

  res.json({ id: info.lastInsertRowid });
}));

// Community tournaments — any player with a claimed name.
app.post('/api/tournaments', requirePlayer, wrap(async (req, res) => {
  let fields;
  try { fields = buildTournamentFromBody(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const info = await dbRun(`
    INSERT INTO tournaments (name, game, description, format, max_participants, starts_at, status, is_official, host_player_id)
    VALUES (?, ?, ?, 'single_elimination', ?, ?, 'signups_open', 0, ?)
  `, [fields.name, fields.game, fields.description, fields.max_participants, fields.starts_at, req.player.id]);

  res.json({ id: info.lastInsertRowid });
}));

// ===================== TOURNAMENT MANAGEMENT (admin OR the community host who created it) =====================
async function loadManageableTournament(req, res) {
  const t = await dbGet('SELECT * FROM tournaments WHERE id = ?', [req.params.id]);
  if (!t) { res.status(404).json({ error: 'Not found' }); return null; }
  const admin = await isAdminRequest(req);
  const player = await getPlayerFromRequest(req);
  const isHost = !!(player && t.host_player_id === player.id);
  if (!admin && !isHost) { res.status(403).json({ error: 'Not authorized to manage this tournament' }); return null; }
  return t;
}

app.patch('/api/tournaments/:id', wrap(async (req, res) => {
  const t = await loadManageableTournament(req, res);
  if (!t) return;
  const fields = ['name', 'description', 'starts_at', 'status'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body && req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length) {
    values.push(t.id);
    await dbRun(`UPDATE tournaments SET ${updates.join(', ')} WHERE id = ?`, values);
  }
  req.app.get('io').to(`tournament:${t.id}`).emit('bracket:update');
  res.json({ ok: true });
}));

app.delete('/api/tournaments/:id', wrap(async (req, res) => {
  const t = await loadManageableTournament(req, res);
  if (!t) return;
  await dbRun('DELETE FROM tournaments WHERE id = ?', [t.id]);
  res.json({ ok: true });
}));

app.get('/api/tournaments/:id/roster', wrap(async (req, res) => {
  const t = await loadManageableTournament(req, res);
  if (!t) return;
  const rows = await dbAll(`
    SELECT p.id, pl.name AS display_name, p.contact, p.seed, p.created_at
    FROM participants p JOIN players pl ON pl.id = p.player_id
    WHERE p.tournament_id = ? ORDER BY p.id
  `, [t.id]);
  res.json(rows);
}));

app.post('/api/tournaments/:id/start', wrap(async (req, res) => {
  const t = await loadManageableTournament(req, res);
  if (!t) return;
  if (t.status !== 'signups_open') return res.status(400).json({ error: 'Tournament already started' });
  try {
    await generateBracket(t.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await dbRun("UPDATE tournaments SET status = 'in_progress' WHERE id = ?", [t.id]);
  req.app.get('io').to(`tournament:${t.id}`).emit('bracket:update');
  res.json({ ok: true });
}));

app.post('/api/matches/:matchId/winner', wrap(async (req, res) => {
  const match = await dbGet('SELECT * FROM matches WHERE id = ?', [req.params.matchId]);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  const admin = await isAdminRequest(req);
  const player = await getPlayerFromRequest(req);
  const tournament = await dbGet('SELECT * FROM tournaments WHERE id = ?', [match.tournament_id]);
  const isHost = !!(player && tournament && tournament.host_player_id === player.id);
  if (!admin && !isHost) return res.status(403).json({ error: 'Not authorized to manage this tournament' });

  try {
    await setMatchWinner(match.id, (req.body || {}).winner_id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  req.app.get('io').to(`tournament:${match.tournament_id}`).emit('bracket:update');
  res.json({ ok: true });
}));

// ===================== ADMIN AUTH =====================
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}
const effectivePasswordHash = sha256(effectivePassword);

app.post('/api/admin/login', wrap(async (req, res) => {
  const { password } = req.body || {};
  const matches = typeof password === 'string' &&
    crypto.timingSafeEqual(sha256(password), effectivePasswordHash);
  if (!matches) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = newToken();
  await dbRun('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)', [token, Date.now() + SESSION_MS]);
  setCookie(res, 'admin_session', token, SESSION_MS);
  res.json({ ok: true });
}));

app.post('/api/admin/logout', wrap(async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.admin_session) {
    await dbRun('DELETE FROM admin_sessions WHERE token = ?', [cookies.admin_session]);
  }
  clearCookie(res, 'admin_session');
  res.json({ ok: true });
}));

app.get('/api/admin/whoami', wrap(async (req, res) => {
  res.json({ loggedIn: await isAdminRequest(req) });
}));

// ===================== STATIC SITE =====================
const siteRoot = path.join(__dirname, '..');
app.use(express.static(siteRoot));

// Must be registered after every route/middleware above — Express only
// reaches this once something upstream calls next(err), which is what
// wrap() does for any rejected promise from an async route handler.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[tournaments] unhandled route error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' });
});

// ===================== SOCKET.IO (live chat + bracket pushes) =====================
const chatRateLimit = new Map(); // socket.id -> last message timestamp

io.on('connection', socket => {
  socket.on('join', async ({ tournamentId }) => {
    if (!tournamentId) return;
    socket.join(`tournament:${tournamentId}`);
    try {
      const history = (await dbAll(
        'SELECT display_name, message, created_at FROM chat_messages WHERE tournament_id = ? ORDER BY id DESC LIMIT 50',
        [tournamentId]
      )).reverse();
      socket.emit('chat:history', history);
    } catch (err) {
      console.error('[tournaments] failed to load chat history:', err);
    }
  });

  socket.on('chat:send', async ({ tournamentId, token, message }) => {
    try {
      if (!tournamentId || !message || !token) return;
      const last = chatRateLimit.get(socket.id) || 0;
      if (Date.now() - last < 1200) {
        socket.emit('chat:error', { reason: 'rate_limited', message: "You're sending messages too fast — wait a moment." });
        return;
      }
      chatRateLimit.set(socket.id, Date.now());

      // Look up the sender's name server-side from their claim token — never
      // trust a client-supplied display name, or anyone could chat as anyone.
      const player = await dbGet('SELECT * FROM players WHERE token = ?', [token]);
      if (!player) {
        socket.emit('chat:error', { reason: 'invalid_identity', message: "Your session isn't recognized anymore — please re-claim your name." });
        return;
      }

      const text = String(message).trim().slice(0, 300);
      if (!text) return;

      await dbRun('INSERT INTO chat_messages (tournament_id, display_name, message) VALUES (?, ?, ?)', [tournamentId, player.name, text]);

      io.to(`tournament:${tournamentId}`).emit('chat:new', {
        display_name: player.name,
        message: text,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[tournaments] chat:send failed:', err);
      socket.emit('chat:error', { reason: 'server_error', message: 'Message failed to send — try again.' });
    }
  });

  socket.on('disconnect', () => chatRateLimit.delete(socket.id));
});

server.listen(PORT, () => {
  console.log(`[tournaments] listening on http://localhost:${PORT}`);
});
