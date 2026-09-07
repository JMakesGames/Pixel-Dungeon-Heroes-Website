const { db } = require('./db');
const { computePlacements } = require('./points');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextPowerOf2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Builds round 1 (with byes auto-resolved) plus empty shells for every later round. */
function generateBracket(tournamentId) {
  const participants = db.prepare('SELECT id FROM participants WHERE tournament_id = ? ORDER BY id').all(tournamentId);
  if (participants.length < 2) throw new Error('Need at least 2 participants to start a bracket');

  const bracketSize = nextPowerOf2(participants.length);
  const byeCount = bracketSize - participants.length;

  // Byes must each pair against a real participant (never against another bye),
  // so pick the bye recipients first, then pair up everyone left.
  const shuffled = shuffle(participants.map(p => p.id));
  const byeIds = shuffled.slice(0, byeCount);
  const playIds = shuffled.slice(byeCount);
  const round1Matches = shuffle([
    ...byeIds.map(id => [id, null]),
    ...Array.from({ length: playIds.length / 2 }, (_, i) => [playIds[i * 2], playIds[i * 2 + 1]]),
  ]);

  const totalRounds = Math.log2(bracketSize);
  const insertMatch = db.prepare(`
    INSERT INTO matches (tournament_id, round, slot, participant1_id, participant2_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Round 1
    round1Matches.forEach(([p1, p2], slot) => {
      const winner = p2 === null ? p1 : null; // p1 is never null by construction above
      const status = winner === null ? 'ready' : 'done';
      insertMatch.run(tournamentId, 1, slot, p1, p2, status);
      if (winner !== null) {
        db.prepare('UPDATE matches SET winner_id = ? WHERE tournament_id = ? AND round = 1 AND slot = ?')
          .run(winner, tournamentId, slot);
      }
    });
    // Empty shells for every later round
    for (let round = 2; round <= totalRounds; round++) {
      const matchesInRound = bracketSize / Math.pow(2, round);
      for (let slot = 0; slot < matchesInRound; slot++) {
        insertMatch.run(tournamentId, round, slot, null, null, 'pending');
      }
    }
  });
  tx();

  // Propagate any round-1 byes forward (may cascade into filling round 2 slots).
  const round1Winners = db.prepare(
    'SELECT id, slot, winner_id FROM matches WHERE tournament_id = ? AND round = 1 AND winner_id IS NOT NULL'
  ).all(tournamentId);
  for (const m of round1Winners) propagateWinner(tournamentId, 1, m.slot, m.winner_id);

  maybeCompleteTournament(tournamentId);
}

/** Pushes a round's winner into the correct slot of the next round's match. */
function propagateWinner(tournamentId, round, slot, winnerId) {
  const nextRound = round + 1;
  const nextSlot = Math.floor(slot / 2);
  const nextMatch = db.prepare(
    'SELECT * FROM matches WHERE tournament_id = ? AND round = ? AND slot = ?'
  ).get(tournamentId, nextRound, nextSlot);
  if (!nextMatch) return; // round was the final — nothing further to fill

  const field = slot % 2 === 0 ? 'participant1_id' : 'participant2_id';
  db.prepare(`UPDATE matches SET ${field} = ? WHERE id = ?`).run(winnerId, nextMatch.id);

  const updated = db.prepare('SELECT * FROM matches WHERE id = ?').get(nextMatch.id);
  if (updated.participant1_id && updated.participant2_id) {
    db.prepare('UPDATE matches SET status = ? WHERE id = ?').run('ready', nextMatch.id);
  }
}

function setMatchWinner(matchId, winnerId) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Match not found');
  if (match.status !== 'ready') throw new Error('Match is not ready to be decided');
  if (winnerId !== match.participant1_id && winnerId !== match.participant2_id) {
    throw new Error('Winner must be one of the two match participants');
  }
  db.prepare('UPDATE matches SET winner_id = ?, status = ? WHERE id = ?').run(winnerId, 'done', matchId);
  propagateWinner(match.tournament_id, match.round, match.slot, winnerId);
  maybeCompleteTournament(match.tournament_id);
}

function maybeCompleteTournament(tournamentId) {
  const matches = db.prepare('SELECT * FROM matches WHERE tournament_id = ?').all(tournamentId);
  if (!matches.length) return;
  const maxRound = Math.max(...matches.map(m => m.round));
  const final = matches.find(m => m.round === maxRound);
  if (final && final.status === 'done') {
    db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run('completed', tournamentId);
    computePlacements(tournamentId);
  }
}

module.exports = { generateBracket, setMatchWinner };
