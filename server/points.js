const { db } = require('./db');

// Points only apply to official (admin-hosted) tournaments. Ties are handled the
// way most brackets without a 3rd-place decider match do it: both semifinal
// losers share the "3rd-4th" tier and its point value, same idea as Olympic
// bronze ties. Values are round numbers chosen to reward each tier meaningfully
// while making 1st place clearly worth the most.
const TIERS_BY_ROUNDS_FROM_FINAL = {
  1: { tier: '3rd-4th', points: 50 },
  2: { tier: '5th-8th', points: 25 },
  3: { tier: '9th-16th', points: 15 },
  4: { tier: '17th-32nd', points: 8 },
  5: { tier: '33rd-64th', points: 1 },
};
const FIRST_PLACE = { tier: '1st', points: 100 };
const SECOND_PLACE = { tier: '2nd', points: 75 };

function playerIdFor(participantId, participantToPlayer) {
  return participantId === null ? null : participantToPlayer.get(participantId) || null;
}

/** Walks a completed bracket backward from the final and records placements + points. Official tournaments only; safe to call more than once (idempotent via INSERT OR IGNORE). */
function computePlacements(tournamentId) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament || !tournament.is_official) return;

  const participants = db.prepare('SELECT id, player_id FROM participants WHERE tournament_id = ?').all(tournamentId);
  const participantToPlayer = new Map(participants.map(p => [p.id, p.player_id]));

  const matches = db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, slot').all(tournamentId);
  if (!matches.length) return;
  const totalRounds = Math.max(...matches.map(m => m.round));

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO results (tournament_id, player_id, placement_tier, points)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const m of matches) {
      if (m.status !== 'done' || m.winner_id === null) continue;
      const loserParticipantId = m.winner_id === m.participant1_id ? m.participant2_id : m.participant1_id;
      const winnerPlayerId = playerIdFor(m.winner_id, participantToPlayer);
      const loserPlayerId = playerIdFor(loserParticipantId, participantToPlayer);

      if (m.round === totalRounds) {
        if (winnerPlayerId) insertResult.run(tournamentId, winnerPlayerId, FIRST_PLACE.tier, FIRST_PLACE.points);
        if (loserPlayerId) insertResult.run(tournamentId, loserPlayerId, SECOND_PLACE.tier, SECOND_PLACE.points);
        continue;
      }
      // A null loser means this was a bye (no one was actually eliminated here).
      if (!loserPlayerId) continue;
      const roundsFromFinal = totalRounds - m.round;
      const band = TIERS_BY_ROUNDS_FROM_FINAL[roundsFromFinal] || { tier: `round ${m.round}`, points: 1 };
      insertResult.run(tournamentId, loserPlayerId, band.tier, band.points);
    }
  });
  tx();
}

module.exports = { computePlacements, TIERS_BY_ROUNDS_FROM_FINAL, FIRST_PLACE, SECOND_PLACE };
