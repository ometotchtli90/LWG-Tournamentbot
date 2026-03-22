'use strict';

// ═══════════════════════════════════════════════════════════
// BRACKET ENGINE
// Supports: single_elimination | double_elimination | swiss
// ═══════════════════════════════════════════════════════════

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextPow2(n) {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

function makeMatch(p1, p2, meta = {}) {
  return { p1, p2, winner: null, loser: null, id: `${meta.bracket||'M'}-${meta.roundIdx||0}-${meta.matchIdx||0}`, ...meta };
}

// How many worker accounts are needed for a given max player count
function requiredWorkers(maxPlayers) {
  return Math.ceil(maxPlayers / 2);
}

// ═══════════════════════════════════════════════════════════
// SINGLE ELIMINATION
// ═══════════════════════════════════════════════════════════

function buildSingleElim(players) {
  const seeded = shuffle(players);
  const size   = nextPow2(seeded.length);
  while (seeded.length < size) seeded.push('BYE');

  const rounds = [];
  const r1     = [];
  for (let i = 0; i < seeded.length; i += 2) {
    r1.push(makeMatch(seeded[i], seeded[i + 1], { bracket: 'SE', roundIdx: 0, matchIdx: r1.length }));
  }
  rounds.push(r1);

  let prev = r1, ri = 1;
  while (prev.length > 1) {
    const r = [];
    for (let i = 0; i < Math.ceil(prev.length / 2); i++) {
      r.push(makeMatch(null, null, { bracket: 'SE', roundIdx: ri, matchIdx: i }));
    }
    rounds.push(r);
    prev = r; ri++;
  }

  return { format: 'single_elimination', rounds, eliminated: [] };
}

function applyWinSingle(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;
  if (loser && loser !== 'BYE') bracket.eliminated.push(loser);

  const nextRi = match.roundIdx + 1;
  if (nextRi < bracket.rounds.length) {
    const next = bracket.rounds[nextRi][Math.floor(match.matchIdx / 2)];
    if (next) { if (match.matchIdx % 2 === 0) next.p1 = winner; else next.p2 = winner; }
  }
  return { winner, loser };
}

function autoByesSingle(bracket) {
  bracket.rounds[0].forEach(m => {
    if (m.p1 === 'BYE' || m.p2 === 'BYE') {
      applyWinSingle(bracket, m, m.p1 === 'BYE' ? m.p2 : m.p1);
    }
  });
}

function readyMatchesSingle(bracket) {
  const ready = [];
  for (const round of bracket.rounds) {
    for (const m of round) {
      if (!m.winner && m.p1 && m.p2 && m.p1 !== 'BYE' && m.p2 !== 'BYE') ready.push(m);
    }
  }
  return ready;
}

function isCompleteSingle(bracket) {
  return !!bracket.rounds[bracket.rounds.length - 1]?.[0]?.winner;
}

function championSingle(bracket) {
  return bracket.rounds[bracket.rounds.length - 1]?.[0]?.winner || null;
}

// ═══════════════════════════════════════════════════════════
// DOUBLE ELIMINATION
// ═══════════════════════════════════════════════════════════

function buildDoubleElim(players) {
  const seeded = shuffle(players);
  const size   = nextPow2(seeded.length);
  while (seeded.length < size) seeded.push('BYE');

  // Winner bracket
  const wb = [];
  const r1 = [];
  for (let i = 0; i < seeded.length; i += 2) {
    r1.push(makeMatch(seeded[i], seeded[i + 1], { bracket: 'W', roundIdx: 0, matchIdx: r1.length }));
  }
  wb.push(r1);
  let prev = r1, ri = 1;
  while (prev.length > 1) {
    const r = [];
    for (let i = 0; i < Math.ceil(prev.length / 2); i++) {
      r.push(makeMatch(null, null, { bracket: 'W', roundIdx: ri, matchIdx: i }));
    }
    wb.push(r); prev = r; ri++;
  }

  // Loser bracket — 2*(wbRounds-1) rounds
  const lb        = [];
  const lbRounds  = Math.max(2, (wb.length - 1) * 2);
  let   lbSize    = Math.max(1, r1.length / 2);
  for (let r = 0; r < lbRounds; r++) {
    const round = [];
    for (let i = 0; i < Math.max(1, lbSize); i++) {
      round.push(makeMatch(null, null, { bracket: 'L', roundIdx: r, matchIdx: i }));
    }
    lb.push(round);
    if (r % 2 === 1) lbSize = Math.max(1, Math.ceil(lbSize / 2));
  }

  // Grand Final
  const gf = [makeMatch(null, null, { bracket: 'GF', roundIdx: 0, matchIdx: 0 })];

  return {
    format: 'double_elimination',
    wb, lb, gf,
    eliminated:  [],
    lbDropQueue: [],
  };
}

function applyWinDouble(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;

  if (match.bracket === 'W') {
    if (loser && loser !== 'BYE') {
      bracket.lbDropQueue.push({ loser, fromWbRound: match.roundIdx, matchIdx: match.matchIdx });
      placeLbDrops(bracket);
    }
    // Propagate winner in WB
    const nextRi = match.roundIdx + 1;
    if (nextRi < bracket.wb.length) {
      const next = bracket.wb[nextRi][Math.floor(match.matchIdx / 2)];
      if (next) { if (match.matchIdx % 2 === 0) next.p1 = winner; else next.p2 = winner; }
    } else {
      bracket.gf[0].p1 = winner;
    }
  } else if (match.bracket === 'L') {
    if (loser && loser !== 'BYE') bracket.eliminated.push(loser);
    const nextRi = match.roundIdx + 1;
    if (nextRi < bracket.lb.length) {
      const next = bracket.lb[nextRi][Math.floor(match.matchIdx / 2)];
      if (next) { if (match.matchIdx % 2 === 0) next.p1 = winner; else next.p2 = winner; }
    } else {
      bracket.gf[0].p2 = winner;
    }
  } else if (match.bracket === 'GF') {
    if (loser && loser !== 'BYE') bracket.eliminated.push(loser);
    bracket.gf[0].winner = winner;
    bracket.gf[0].loser  = loser;
  }

  return { winner, loser };
}

function placeLbDrops(bracket) {
  bracket.lbDropQueue = bracket.lbDropQueue.filter(drop => {
    const targetR = Math.max(0, drop.fromWbRound * 2 - 1);
    const lbR     = bracket.lb[Math.min(targetR, bracket.lb.length - 1)];
    if (!lbR) return false;
    const slot = lbR.find(m => !m.winner && (!m.p1 || !m.p2));
    if (!slot) return true; // keep in queue
    if (!slot.p1) slot.p1 = drop.loser;
    else          slot.p2 = drop.loser;
    return false;
  });
}

function autoByesDouble(bracket) {
  bracket.wb[0].forEach(m => {
    if (m.p1 === 'BYE' || m.p2 === 'BYE') {
      applyWinDouble(bracket, m, m.p1 === 'BYE' ? m.p2 : m.p1);
    }
  });
}

function readyMatchesDouble(bracket) {
  const ready = [];
  [...bracket.wb, ...bracket.lb, bracket.gf].forEach(round => {
    (Array.isArray(round) ? round : [round]).forEach(m => {
      if (m && !m.winner && m.p1 && m.p2 && m.p1 !== 'BYE' && m.p2 !== 'BYE') ready.push(m);
    });
  });
  return ready;
}

function isCompleteDouble(bracket) { return !!bracket.gf[0]?.winner; }
function championDouble(bracket)   { return bracket.gf[0]?.winner || null; }

// ═══════════════════════════════════════════════════════════
// SWISS
// ═══════════════════════════════════════════════════════════

function swissRounds(playerCount) {
  return Math.ceil(Math.log2(Math.max(2, playerCount)));
}

function buildSwiss(players) {
  return {
    format:       'swiss',
    totalRounds:  swissRounds(players.length),
    currentRound: 0,
    rounds:       [],
    tiebreakers:  [],
    standings:    players.map(p => ({ player: p, wins: 0, losses: 0, opponents: [] })),
    eliminated:   [],
    phase:        'rounds', // 'rounds' | 'tiebreakers' | 'done'
  };
}

function pairSwissRound(bracket) {
  const active = bracket.standings.filter(s => !bracket.eliminated.includes(s.player));
  const sorted = [...active].sort((a, b) => b.wins - a.wins || a.player.localeCompare(b.player));
  const paired = new Set();
  const matches = [];
  const ri = bracket.currentRound;

  for (let i = 0; i < sorted.length; i++) {
    if (paired.has(sorted[i].player)) continue;
    let found = false;
    for (let j = i + 1; j < sorted.length; j++) {
      if (paired.has(sorted[j].player)) continue;
      if (sorted[i].opponents.includes(sorted[j].player)) continue;
      matches.push(makeMatch(sorted[i].player, sorted[j].player, {
        bracket: 'S', roundIdx: ri, matchIdx: matches.length,
      }));
      paired.add(sorted[i].player);
      paired.add(sorted[j].player);
      found = true;
      break;
    }
    // Fallback: allow rematches if no fresh opponent available
    if (!found) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (paired.has(sorted[j].player)) continue;
        matches.push(makeMatch(sorted[i].player, sorted[j].player, {
          bracket: 'S', roundIdx: ri, matchIdx: matches.length, rematch: true,
        }));
        paired.add(sorted[i].player);
        paired.add(sorted[j].player);
        break;
      }
    }
  }

  // BYE for unpaired player
  sorted.forEach(s => {
    if (!paired.has(s.player)) {
      const m = makeMatch(s.player, 'BYE', { bracket: 'S', roundIdx: ri, matchIdx: matches.length });
      m.winner = s.player; m.loser = 'BYE';
      const st = bracket.standings.find(x => x.player === s.player);
      if (st) { st.wins++; st.opponents.push('BYE'); }
      matches.push(m);
    }
  });

  bracket.rounds.push(matches);
  return matches;
}

function applySwissResult(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;
  const ws = bracket.standings.find(s => s.player === winner);
  const ls = bracket.standings.find(s => s.player === loser);
  if (ws) { ws.wins++;   ws.opponents.push(loser);  }
  if (ls) { ls.losses++; ls.opponents.push(winner); }
  return { winner, loser };
}

function applyTiebreakerResult(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;
  return { winner, loser };
}

function swissRoundComplete(bracket) {
  if (!bracket.rounds.length) return false;
  return bracket.rounds[bracket.currentRound]?.every(m => m.winner !== null) ?? false;
}

function readyMatchesSwiss(bracket) {
  if (bracket.phase === 'tiebreakers') {
    return bracket.tiebreakers.filter(m => !m.winner && m.p1 && m.p2);
  }
  const cur = bracket.rounds[bracket.currentRound];
  if (!cur) return [];
  return cur.filter(m => !m.winner && m.p1 && m.p2 && m.p2 !== 'BYE');
}

function buildSwissTiebreakers(bracket) {
  const sorted = swissStandings(bracket);
  const groups = {};
  sorted.forEach(s => {
    const k = s.wins;
    if (!groups[k]) groups[k] = [];
    groups[k].push(s.player);
  });

  const tbs = [];
  Object.values(groups).forEach(group => {
    for (let i = 0; i + 1 < group.length; i += 2) {
      tbs.push(makeMatch(group[i], group[i + 1], { bracket: 'TB', roundIdx: 0, matchIdx: tbs.length }));
    }
  });

  bracket.tiebreakers = tbs;
  bracket.phase       = tbs.length ? 'tiebreakers' : 'done';
  return tbs;
}

function isCompleteSwiss(bracket) {
  if (bracket.phase === 'done') return true;
  if (bracket.phase === 'tiebreakers') return bracket.tiebreakers.every(m => m.winner !== null);
  return false;
}

function swissStandings(bracket) {
  return [...bracket.standings].sort((a, b) => b.wins - a.wins || a.player.localeCompare(b.player));
}

function championSwiss(bracket) {
  return swissStandings(bracket)[0]?.player || null;
}

// ═══════════════════════════════════════════════════════════
// UNIFIED READY MATCHES
// ═══════════════════════════════════════════════════════════

function readyMatches(bracket) {
  switch (bracket.format) {
    case 'single_elimination': return readyMatchesSingle(bracket);
    case 'double_elimination': return readyMatchesDouble(bracket);
    case 'swiss':              return readyMatchesSwiss(bracket);
    default: return [];
  }
}

function applyWin(bracket, match, winner) {
  switch (bracket.format) {
    case 'single_elimination': return applyWinSingle(bracket, match, winner);
    case 'double_elimination': return applyWinDouble(bracket, match, winner);
    case 'swiss':
      return match.bracket === 'TB'
        ? applyTiebreakerResult(bracket, match, winner)
        : applySwissResult(bracket, match, winner);
    default: return { winner, loser: null };
  }
}

function isComplete(bracket) {
  switch (bracket.format) {
    case 'single_elimination': return isCompleteSingle(bracket);
    case 'double_elimination': return isCompleteDouble(bracket);
    case 'swiss':              return isCompleteSwiss(bracket);
    default: return false;
  }
}

function champion(bracket) {
  switch (bracket.format) {
    case 'single_elimination': return championSingle(bracket);
    case 'double_elimination': return championDouble(bracket);
    case 'swiss':              return championSwiss(bracket);
    default: return null;
  }
}

function getRoundName(match, bracket) {
  if (!match) return '';
  const fmt = bracket.format;
  if (fmt === 'single_elimination') {
    const total = bracket.rounds.length;
    const r     = total - match.roundIdx;
    if (r === 1) return 'Grand Final';
    if (r === 2) return 'Semi-Finals';
    if (r === 3) return 'Quarter-Finals';
    return `Round ${match.roundIdx + 1}`;
  }
  if (fmt === 'double_elimination') {
    if (match.bracket === 'GF') return 'Grand Final';
    if (match.bracket === 'W')  return `WB Round ${match.roundIdx + 1}`;
    if (match.bracket === 'L')  return `LB Round ${match.roundIdx + 1}`;
  }

  return '';
}

module.exports = {
  buildSingleElim, autoByesSingle,
  buildDoubleElim, autoByesDouble,
  readyMatches, applyWin, isComplete, champion,
  getRoundName, requiredWorkers, shuffle,
};
