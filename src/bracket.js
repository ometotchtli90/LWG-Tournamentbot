'use strict';

// ── Bracket builder & state ───────────────────────────────

function buildBracket(players) {
  let seeded = [...players].sort(() => Math.random() - 0.5);
  let size = 1;
  while (size < seeded.length) size *= 2;
  while (seeded.length < size) seeded.push('BYE');

  const bracket = [];

  // Round 1
  const round1 = [];
  for (let i = 0; i < seeded.length; i += 2) {
    round1.push(makeMatch(seeded[i], seeded[i + 1], 0, round1.length));
  }
  bracket.push(round1);

  // Remaining empty rounds
  let count = round1.length, ri = 1;
  while (count > 1) {
    count = Math.ceil(count / 2);
    const round = [];
    for (let i = 0; i < count; i++) round.push(makeMatch(null, null, ri, i));
    bracket.push(round);
    ri++;
  }

  return bracket;
}

function makeMatch(p1, p2, roundIdx, matchIdx) {
  return { p1, p2, winner: null, roundIdx, matchIdx };
}

function propagateWinner(bracket, match) {
  const nextRi = match.roundIdx + 1;
  if (nextRi >= bracket.length) return;
  const next = bracket[nextRi][Math.floor(match.matchIdx / 2)];
  if (!next) return;
  if (match.matchIdx % 2 === 0) next.p1 = match.winner;
  else                          next.p2 = match.winner;
}

function autoAdvanceByes(bracket) {
  bracket[0].forEach(m => {
    if (m.p1 === 'BYE')      { m.winner = m.p2; propagateWinner(bracket, m); }
    else if (m.p2 === 'BYE') { m.winner = m.p1; propagateWinner(bracket, m); }
  });
}

function getRoundName(roundIdx, totalRounds) {
  const r = totalRounds - roundIdx;
  if (r === 1) return 'GRAND FINAL';
  if (r === 2) return 'SEMI-FINALS';
  if (r === 3) return 'QUARTER-FINALS';
  return `ROUND ${roundIdx + 1}`;
}

function getEliminated(bracket, players) {
  const eliminated = new Set();
  bracket.forEach(round => round.forEach(m => {
    if (m.winner) {
      const loser = m.p1 === m.winner ? m.p2 : m.p1;
      if (loser && loser !== 'BYE') eliminated.add(loser);
    }
  }));
  return { alive: players.filter(p => !eliminated.has(p)), eliminated: [...eliminated] };
}

module.exports = { buildBracket, propagateWinner, autoAdvanceByes, getRoundName, getEliminated };
