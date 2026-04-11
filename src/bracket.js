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

    const isFirstRealRound = (byeCount > 0 && ri === 1) || (byeCount === 0 && ri === 0);
    if (isFirstRealRound && byeCount > 0) {
      for (let i = 0; i < byePlayers.length; i++) {
        const matchIdx = Math.floor(i / 2);
        const slot     = i % 2 === 0 ? 'p1' : 'p2';
        if (r[matchIdx]) r[matchIdx][slot] = byePlayers[i];
      }

      let r1WinnerIdx = 0;
      for (let mi = 0; mi < r.length && r1WinnerIdx < r1.length; mi++) {
        if (!r[mi].p1) {
          r1[r1WinnerIdx].nextMatchIdx  = mi;
          r1[r1WinnerIdx].nextMatchSlot = 'p1';
          r[mi].p1 = '__R1_WINNER__';
          r1WinnerIdx++;
        }
        if (r1WinnerIdx < r1.length && !r[mi].p2) {
          r1[r1WinnerIdx].nextMatchIdx  = mi;
          r1[r1WinnerIdx].nextMatchSlot = 'p2';
          r[mi].p2 = '__R1_WINNER__';
          r1WinnerIdx++;
        }
      }
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

    if (match.nextMatchIdx !== undefined) {
      next = bracket.rounds[nextRi][match.nextMatchIdx];
      slot = match.nextMatchSlot || (match.matchIdx % 2 === 0 ? 'p1' : 'p2');
    } else {
      next = bracket.rounds[nextRi][Math.floor(match.matchIdx / 2)];
      slot = match.matchIdx % 2 === 0 ? 'p1' : 'p2';
    }

    if (next) {
      if (match.nextMatchIdx !== undefined) {
        next[slot] = winner;
      } else if (!next.p1) {
        next.p1 = winner;
      } else if (!next.p2) {
        next.p2 = winner;
      } else {
        next[slot] = winner;
      }
    }
  }
  return { winner, loser };
}

function autoByesSingle(bracket) {
  // No-op — balanced bracket has no BYE matches
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
// DOUBLE ELIMINATION — BYE-FREE BALANCED APPROACH
//
// Key idea: for n players, find the largest power-of-2 ≤ n
// (lowerPow2). The "excess" = n - lowerPow2 players play a
// pre-round (WB R0). Winners join lowerPow2-excess "bye-seeds"
// in WB R1 (the first full round, lowerPow2/2 matches).
// NO 'BYE' strings — every match has two real players.
//
// LB structure:
//   • If there's a pre-round: LB R0 receives pre-round losers
//     (paired up). Then standard LB rounds follow.
//   • Standard LB: 2*(wbMainRounds-1) rounds.
//     Even rounds = consolidation (LB survivors play each other).
//     Odd rounds  = drop (LB survivor vs fresh WB loser).
// ═══════════════════════════════════════════════════════════

function buildDoubleElim(players) {
  const seeded = shuffle(players);
  const n      = seeded.length;

  // Special case: 2 players — just WB + GF, no LB
  if (n === 2) {
    const wb = [[makeMatch(seeded[0], seeded[1], { bracket: 'W', roundIdx: 0, matchIdx: 0 })]];
    const gf = [makeMatch(null, null, { bracket: 'GF', roundIdx: 0, matchIdx: 0 })];
    wb[0][0]._winNext  = { src: 'gf', ri: 0, mi: 0, slot: 'p1' };
    wb[0][0]._loseNext = { src: 'gf', ri: 0, mi: 0, slot: 'p2' };
    return { format: 'double_elimination', wb, lb: [], gf, eliminated: [], byeSeeds: [] };
  }

  // Special case: 3 players
  if (n === 3) {
    const wb = [];
    const r0 = [makeMatch(seeded[1], seeded[2], { bracket: 'W', roundIdx: 0, matchIdx: 0 })];
    wb.push(r0);
    const r1 = [makeMatch(seeded[0], null, { bracket: 'W', roundIdx: 1, matchIdx: 0 })];
    wb.push(r1);
    const lb = [[makeMatch(null, null, { bracket: 'L', roundIdx: 0, matchIdx: 0 })]];
    const gf = [makeMatch(null, null, { bracket: 'GF', roundIdx: 0, matchIdx: 0 })];

    r0[0]._winNext  = { src: 'wb', ri: 1, mi: 0, slot: 'p2' };
    r0[0]._loseNext = { src: 'lb', ri: 0, mi: 0, slot: 'p1' };
    r1[0]._winNext  = { src: 'gf', ri: 0, mi: 0, slot: 'p1' };
    r1[0]._loseNext = { src: 'lb', ri: 0, mi: 0, slot: 'p2' };
    lb[0][0]._winNext = { src: 'gf', ri: 0, mi: 0, slot: 'p2' };

    return { format: 'double_elimination', wb, lb, gf, eliminated: [], byeSeeds: [seeded[0]] };
  }

  // ── General case: 4+ players ────────────────────────────
  const isPow2      = (n & (n - 1)) === 0;
  const lowerPow2   = isPow2 ? n : nextPow2(n) >> 1;   // largest pow2 ≤ n
  const excess       = n - lowerPow2;                    // players in pre-round
  const hasPreRound  = excess > 0;
  const mainSize     = lowerPow2 / 2;                    // matches in WB R1

  // Split: bye-seeds skip pre-round, excess players play pre-round
  const byeSeeds   = seeded.slice(0, lowerPow2 - excess); // go straight to WB R1
  const r0Players  = seeded.slice(lowerPow2 - excess);    // play WB R0 pre-round

  // ── Winner Bracket ──────────────────────────────────────
  const wb = [];

  // WB R0: pre-round (only if not power-of-2)
  if (hasPreRound) {
    const r0 = [];
    for (let i = 0; i < r0Players.length; i += 2) {
      r0.push(makeMatch(r0Players[i], r0Players[i + 1], { bracket: 'W', roundIdx: 0, matchIdx: r0.length }));
    }
    wb.push(r0);
  }

  // WB R1 (or WB R0 if power-of-2)
  const mainRoundIdx = hasPreRound ? 1 : 0;
  const r1 = [];
  for (let i = 0; i < mainSize; i++) {
    r1.push(makeMatch(null, null, { bracket: 'W', roundIdx: mainRoundIdx, matchIdx: i }));
  }

  if (hasPreRound) {
    const r0 = wb[0];
    let byeIdx = 0, r0Idx = 0;

    // Fill bye-seeds first
    for (let mi = 0; mi < r1.length; mi++) {
      if (byeIdx < byeSeeds.length) r1[mi].p1 = byeSeeds[byeIdx++];
      if (byeIdx < byeSeeds.length) r1[mi].p2 = byeSeeds[byeIdx++];
    }

    // Assign R0 winners to remaining null slots
    for (let mi = 0; mi < r1.length && r0Idx < r0.length; mi++) {
      if (!r1[mi].p1) {
        r0[r0Idx]._winNext = { src: 'wb', ri: mainRoundIdx, mi, slot: 'p1' };
        r0Idx++;
      }
      if (r0Idx < r0.length && !r1[mi].p2) {
        r0[r0Idx]._winNext = { src: 'wb', ri: mainRoundIdx, mi, slot: 'p2' };
        r0Idx++;
      }
    }
  } else {
    // Power-of-2: everyone plays R1 directly
    for (let i = 0; i < mainSize; i++) {
      r1[i].p1 = seeded[i * 2];
      r1[i].p2 = seeded[i * 2 + 1];
    }
  }
  wb.push(r1);

  // Subsequent WB rounds
  let wbPrev = r1, wbRi = mainRoundIdx + 1;
  while (wbPrev.length > 1) {
    const r = [];
    for (let i = 0; i < wbPrev.length / 2; i++) {
      r.push(makeMatch(null, null, { bracket: 'W', roundIdx: wbRi, matchIdx: i }));
    }
    wb.push(r);
    wbPrev = r;
    wbRi++;
  }

  // ── Loser Bracket ───────────────────────────────────────
  const mainWbStart  = hasPreRound ? 1 : 0;
  const wbMainRounds = wb.length - mainWbStart;           // WB rounds from R1 onward
  const lbStdRounds  = 2 * (wbMainRounds - 1);            // standard LB rounds
  const lb = [];

  // LB R0: pre-round losers (if pre-round exists and has ≥2 losers to pair)
  const hasLbPreRound = hasPreRound && wb[0].length >= 2;
  if (hasLbPreRound) {
    const lbR0Matches = Math.floor(wb[0].length / 2);
    const lbR0 = [];
    for (let i = 0; i < lbR0Matches; i++) {
      lbR0.push(makeMatch(null, null, { bracket: 'L', roundIdx: 0, matchIdx: i }));
    }
    lb.push(lbR0);
  }

  // Standard LB rounds
  const lbOffset = hasLbPreRound ? 1 : 0;
  for (let stdRi = 0; stdRi < lbStdRounds; stdRi++) {
    const consolIdx  = Math.floor(stdRi / 2);
    const matchCount = Math.max(1, mainSize >> (consolIdx + 1));
    const actualRi   = stdRi + lbOffset;
    const round = [];
    for (let i = 0; i < matchCount; i++) {
      round.push(makeMatch(null, null, { bracket: 'L', roundIdx: actualRi, matchIdx: i }));
    }
    lb.push(round);
  }

  // ── Grand Final ─────────────────────────────────────────
  const gf = [makeMatch(null, null, { bracket: 'GF', roundIdx: 0, matchIdx: 0 })];

  // ── Wire WB winner links (R1 onward) ───────────────────
  for (let wbi = mainWbStart; wbi < wb.length; wbi++) {
    for (let i = 0; i < wb[wbi].length; i++) {
      const m = wb[wbi][i];
      if (wbi + 1 < wb.length) {
        m._winNext = { src: 'wb', ri: wbi + 1, mi: Math.floor(i / 2), slot: i % 2 === 0 ? 'p1' : 'p2' };
      } else {
        m._winNext = { src: 'gf', ri: 0, mi: 0, slot: 'p1' };
      }
    }
  }

  // ── Wire WB loser-drop links ────────────────────────────
  // Pre-round losers → LB pre-round
  if (hasPreRound) {
    const r0 = wb[0];
    if (hasLbPreRound) {
      // Pair pre-round losers into LB R0 matches
      for (let i = 0; i < r0.length; i++) {
        const mi = Math.floor(i / 2);
        const slot = i % 2 === 0 ? 'p1' : 'p2';
        r0[i]._loseNext = { src: 'lb', ri: 0, mi, slot };
      }
      // If odd number of pre-round losers, the last one goes directly
      // into the first standard LB round
      if (r0.length % 2 === 1) {
        r0[r0.length - 1]._loseNext = { src: 'lb', ri: lbOffset, mi: 0, slot: 'p1' };
      }
    } else if (r0.length === 1) {
      // Only 1 pre-round loser — goes directly into first standard LB round
      r0[0]._loseNext = { src: 'lb', ri: 0, mi: 0, slot: 'p1' };
    }
  }

  // WB R1 losers → first standard LB consolidation round
  const mainR1 = wb[mainWbStart];
  for (let i = 0; i < mainR1.length; i++) {
    if (!mainR1[i]._loseNext) {
      const lbTargetRi = lbOffset; // first standard LB round
      mainR1[i]._loseNext = {
        src: 'lb', ri: lbTargetRi, mi: Math.floor(i / 2), slot: i % 2 === 0 ? 'p1' : 'p2',
      };
    }
  }

  // WB R2+ losers → LB drop rounds (odd standard rounds)
  for (let w = 1; w < wbMainRounds; w++) {
    const wbi = mainWbStart + w;
    if (wbi >= wb.length) break;
    const lbTargetIdx = lbOffset + (2 * w - 1);
    for (let i = 0; i < wb[wbi].length; i++) {
      wb[wbi][i]._loseNext = { src: 'lb', ri: lbTargetIdx, mi: i, slot: 'p2' };
    }
  }

  // ── Wire LB winner links ────────────────────────────────
  // LB pre-round winners → first standard LB consolidation round
  if (hasLbPreRound) {
    const lbR0 = lb[0];
    for (let i = 0; i < lbR0.length; i++) {
      lbR0[i]._winNext = { src: 'lb', ri: lbOffset, mi: i, slot: 'p1' };
    }
    // Re-wire WB R1 losers that overlap with LB pre-round winners:
    // LB pre-round winners take p1 in lb[lbOffset], WB R1 losers take p2
    for (let i = 0; i < mainR1.length; i++) {
      const target = mainR1[i]._loseNext;
      if (target && target.ri === lbOffset && target.mi < lbR0.length) {
        // This slot's p1 is taken by LB pre-round winner, shift to p2
        mainR1[i]._loseNext = { ...target, slot: 'p2' };
      }
    }
  }

  // Standard LB rounds wiring
  for (let li = lbOffset; li < lb.length; li++) {
    const stdIdx = li - lbOffset;
    for (let i = 0; i < lb[li].length; i++) {
      const m = lb[li][i];
      if (li + 1 < lb.length) {
        if (stdIdx % 2 === 0) {
          m._winNext = { src: 'lb', ri: li + 1, mi: i, slot: 'p1' };
        } else {
          m._winNext = { src: 'lb', ri: li + 1, mi: Math.floor(i / 2), slot: i % 2 === 0 ? 'p1' : 'p2' };
        }
      } else {
        m._winNext = { src: 'gf', ri: 0, mi: 0, slot: 'p2' };
      }
    }
  }

  return { format: 'double_elimination', wb, lb, gf, eliminated: [], byeSeeds };
}

// Follow a _winNext or _loseNext link and place the player into the target slot.
function _placeInto(bracket, link, player) {
  if (!link || !player) return;
  let target;
  if      (link.src === 'wb') target = bracket.wb[link.ri]?.[link.mi];
  else if (link.src === 'lb') target = bracket.lb[link.ri]?.[link.mi];
  else if (link.src === 'gf') target = bracket.gf[link.mi];
  if (target && !target.winner) target[link.slot] = player;
}

function applyWinDouble(bracket, match, winner) {
  const loser  = match.p1 === winner ? match.p2 : match.p1;
  match.winner = winner;
  match.loser  = loser;

  if (match.bracket === 'W') {
    // Skip LB drop if loser was pre-marked eliminated (forfeit / no-show)
    const alreadyElim = loser && (bracket.eliminated || []).includes(loser);
    if (!alreadyElim && loser) {
      _placeInto(bracket, match._loseNext, loser);
    }
    // Advance winner in WB / to GF
    _placeInto(bracket, match._winNext, winner);

  } else if (match.bracket === 'L') {
    if (loser) bracket.eliminated.push(loser);
    _placeInto(bracket, match._winNext, winner);

  } else if (match.bracket === 'GF') {
    if (loser) bracket.eliminated.push(loser);
    bracket.gf[0].winner = winner;
    bracket.gf[0].loser  = loser;
  }

  return { winner, loser };
}

// No-op — the balanced bracket has no BYE matches to auto-resolve.
function autoByesDouble(bracket) {}

function readyMatchesDouble(bracket) {
  const ready = [];
  [...bracket.wb, ...bracket.lb, bracket.gf].forEach(round => {
    (Array.isArray(round) ? round : [round]).forEach(m => {
      if (m && !m.winner && m.p1 && m.p2) ready.push(m);
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

// No-op for double elimination — there are no BYE strings to resolve.
// Kept for API compatibility with controller.js calls.
function resolvePendingByes(bracket) {}

module.exports = {
  buildSingleElim, autoByesSingle,
  buildDoubleElim, autoByesDouble,
  readyMatches, applyWin, isComplete, champion,
  getRoundName, requiredWorkers, shuffle, resolvePendingByes,
};
