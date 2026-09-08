const { dbGet, dbAll, dbRun, withTransaction } = require('./db');
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
async function generateBracket(tournamentId) {
  const participants = await dbAll('SELECT id FROM participants WHERE tournament_id = ? ORDER BY id', [tournamentId]);
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

  await withTransaction(async tx => {
    // Round 1
    for (let slot = 0; slot < round1Matches.length; slot++) {
      const [p1, p2] = round1Matches[slot];
      const winner = p2 === null ? p1 : null; // p1 is never null by construction above
      const status = winner === null ? 'ready' : 'done';
      await tx.run(
        'INSERT INTO matches (tournament_id, round, slot, participant1_id, participant2_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [tournamentId, 1, slot, p1, p2, status]
      );
      if (winner !== null) {
        await tx.run(
          'UPDATE matches SET winner_id = ? WHERE tournament_id = ? AND round = 1 AND slot = ?',
          [winner, tournamentId, slot]
        );
      }
    }
    // Empty shells for every later round
    for (let round = 2; round <= totalRounds; round++) {
      const matchesInRound = bracketSize / Math.pow(2, round);
      for (let slot = 0; slot < matchesInRound; slot++) {
        await tx.run(
          'INSERT INTO matches (tournament_id, round, slot, participant1_id, participant2_id, status) VALUES (?, ?, ?, ?, ?, ?)',
          [tournamentId, round, slot, null, null, 'pending']
        );
      }
    }
  });

  // Propagate any round-1 byes forward (may cascade into filling round 2 slots).
  const round1Winners = await dbAll(
    'SELECT id, slot, winner_id FROM matches WHERE tournament_id = ? AND round = 1 AND winner_id IS NOT NULL',
    [tournamentId]
  );
  for (const m of round1Winners) await propagateWinner(tournamentId, 1, m.slot, m.winner_id);

  await maybeCompleteTournament(tournamentId);
}

/** Pushes a round's winner into the correct slot of the next round's match. */
async function propagateWinner(tournamentId, round, slot, winnerId) {
  const nextRound = round + 1;
  const nextSlot = Math.floor(slot / 2);
  const nextMatch = await dbGet(
    'SELECT * FROM matches WHERE tournament_id = ? AND round = ? AND slot = ?',
    [tournamentId, nextRound, nextSlot]
  );
  if (!nextMatch) return; // round was the final — nothing further to fill

  const field = slot % 2 === 0 ? 'participant1_id' : 'participant2_id';
  await dbRun(`UPDATE matches SET ${field} = ? WHERE id = ?`, [winnerId, nextMatch.id]);

  const updated = await dbGet('SELECT * FROM matches WHERE id = ?', [nextMatch.id]);
  if (updated.participant1_id && updated.participant2_id) {
    await dbRun('UPDATE matches SET status = ? WHERE id = ?', ['ready', nextMatch.id]);
  }
}

async function setMatchWinner(matchId, winnerId) {
  const match = await dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
  if (!match) throw new Error('Match not found');
  if (match.status !== 'ready') throw new Error('Match is not ready to be decided');
  if (winnerId !== match.participant1_id && winnerId !== match.participant2_id) {
    throw new Error('Winner must be one of the two match participants');
  }
  await dbRun('UPDATE matches SET winner_id = ?, status = ? WHERE id = ?', [winnerId, 'done', matchId]);
  await propagateWinner(match.tournament_id, match.round, match.slot, winnerId);
  await maybeCompleteTournament(match.tournament_id);
}

async function maybeCompleteTournament(tournamentId) {
  const matches = await dbAll('SELECT * FROM matches WHERE tournament_id = ?', [tournamentId]);
  if (!matches.length) return;
  const maxRound = Math.max(...matches.map(m => m.round));
  const final = matches.find(m => m.round === maxRound);
  if (final && final.status === 'done') {
    await dbRun('UPDATE tournaments SET status = ? WHERE id = ?', ['completed', tournamentId]);
    await computePlacements(tournamentId);
  }
}

module.exports = { generateBracket, setMatchWinner };
