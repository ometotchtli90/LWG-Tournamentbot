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
  const seeded   = shuffle(players);
  const size     = nextPow2(seeded.length);
  const byeCount = size - seeded.length;

  const byePlayers = seeded.slice(0, byeCount);
  const r1Players  = seeded.slice(byeCount);

  const rounds = [];

  // ── Round 1 ──────────────────────────────────────────────
  // Only the non-bye players play here. We need to track exactly
  // which R2 slot each R1 winner should advance into.
  const r1 = [];
  for (let i = 0; i < r1Players.length; i += 2) {
    r1.push(makeMatch(r1Players[i], r1Players[i + 1], { bracket: 'SE', roundIdx: 0, matchIdx: r1.length }));
  }
  if (r1.length > 0) rounds.push(r1);

  // ── Build subsequent rounds ──────────────────────────────
  let prevSize = byeCount + r1.length;
  let ri = rounds.length;

  while (prevSize > 1) {
    const matchCount = prevSize / 2;
    const r = [];
    for (let i = 0; i < matchCount; i++) {
      r.push(makeMatch(null, null, { bracket: 'SE', roundIdx: ri, matchIdx: i }));
    }
    rounds.push(r);

    // Pre-fill bye seeds into the FIRST round after R1 (i.e. ri === 1 when byeCount > 0,
    // or ri === 0 when there are no byes and everyone plays R1).
    const isFirstRealRound = (byeCount > 0 && ri === 1) || (byeCount === 0 && ri === 0);
    if (isFirstRealRound && byeCount > 0) {
      // Place bye seeds into slots. Each pair of byes fills one match completely.
      // Any leftover odd bye seed takes p1, leaving p2 for an R1 winner.
      for (let i = 0; i < byePlayers.length; i++) {
        const matchIdx = Math.floor(i / 2);
        const slot     = i % 2 === 0 ? 'p1' : 'p2';
        if (r[matchIdx]) r[matchIdx][slot] = byePlayers[i];
      }

      // Now assign R1 matches to the correct R2 slots.
      // Scan R2 for null slots left after bye pre-filling and
      // assign each R1 match to the next available null slot in order.
      let r1WinnerIdx = 0;
      for (let mi = 0; mi < r.length && r1WinnerIdx < r1.length; mi++) {
        if (!r[mi].p1) {
          r1[r1WinnerIdx].nextMatchIdx  = mi;
          r1[r1WinnerIdx].nextMatchSlot = 'p1';
          r[mi].p1 = '__R1_WINNER__'; // mark as assigned so next scan skips it
          r1WinnerIdx++;
        }
        if (r1WinnerIdx < r1.length && !r[mi].p2) {
          r1[r1WinnerIdx].nextMatchIdx  = mi;
          r1[r1WinnerIdx].nextMatchSlot = 'p2';
          r[mi].p2 = '__R1_WINNER__'; // mark as assigned
          r1WinnerIdx++;
        }
      }
      // Clear the placeholder markers — real values come from applyWinSingle
      for (const m of r) {
        if (m.p1 === '__R1_WINNER__') m.p1 = null;
        if (m.p2 === '__R1_WINNER__') m.p2 = null;
      }
    }

    prevSize = matchCount;
    ri++;
  }

  return { format: 'single_elimination', rounds, eliminated: [], byeSeeds: byePlayers };
}

function applyWinSingle(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;
  if (loser && loser !== 'BYE') bracket.eliminated.push(loser);

  const nextRi = match.roundIdx + 1;
  if (nextRi < bracket.rounds.length) {
    let next, slot;

    // If this R1 match has a pre-computed nextMatchIdx, use it directly.
    // This handles non-power-of-2 player counts where bye seeds have pre-filled
    // some R2 slots and the standard matchIdx/2 formula would target a full slot.
    if (match.nextMatchIdx !== undefined) {
      next = bracket.rounds[nextRi][match.nextMatchIdx];
      slot = match.nextMatchSlot || (match.matchIdx % 2 === 0 ? 'p1' : 'p2');
    } else {
      next = bracket.rounds[nextRi][Math.floor(match.matchIdx / 2)];
      slot = match.matchIdx % 2 === 0 ? 'p1' : 'p2';
    }

    if (next) {
      // Use the pre-computed slot if available, otherwise fill whichever is empty
      if (match.nextMatchIdx !== undefined) {
        next[slot] = winner;
      } else if (!next.p1) {
        next.p1 = winner;
      } else if (!next.p2) {
        next.p2 = winner;
      } else {
        next[slot] = winner; // fallback
      }
    }
  }
  return { winner, loser };
}

function autoByesSingle(bracket) {
  // With the new balanced bracket, BYEs are handled structurally —
  // bye seeds are pre-filled into R2 slots, so there are no BYE matches to auto-resolve.
  // This function is kept for API compatibility but is a no-op.
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

// ── Auto-resolve any BYE matches that became ready ───────
// Call this after every applyWin to propagate BYEs in later rounds.
// For single_elimination, BYEs are now structural (no BYE string players),
// so this only applies to double_elimination.
function resolvePendingByes(bracket) {
  let resolved = true;
  while (resolved) {
    resolved = false;
    const fmt = bracket.format;
    if (fmt === 'double_elimination') {
      const allRounds = [...(bracket.wb || []), ...(bracket.lb || []), bracket.gf || []].flat();
      for (const m of allRounds) {
        if (!m || m.winner) continue;
        if ((m.p1 === 'BYE' || m.p2 === 'BYE') && (m.p1 || m.p2)) {
          const winner = m.p1 === 'BYE' ? m.p2 : m.p1;
          if (winner && winner !== 'BYE') {
            applyWinDouble(bracket, m, winner);
            resolved = true;
          }
        }
      }
    }
  }
}

module.exports = {
  buildSingleElim, autoByesSingle,
  buildDoubleElim, autoByesDouble,
  readyMatches, applyWin, isComplete, champion,
  getRoundName, requiredWorkers, shuffle, resolvePendingByes,
};
