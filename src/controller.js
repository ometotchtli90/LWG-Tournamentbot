'use strict';

const { chromium } = require('playwright');
const cfg          = require('./config');
const ph           = require('./pageHelpers');
const workerMod    = require('./worker');
const B            = require('./bracket');
const lb           = require('./leaderboardClient');

// ── Launch browser (Chrome → Edge → Chromium fallback) ────
async function launchBrowser(headless = false) {
  const channels = ['chrome', 'msedge', 'chrome-beta', 'chromium'];
  let lastErr;
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        channel:  channel === 'chromium' ? undefined : channel,
        headless,
        args: ['--mute-audio'],
      });
      console.log(`  Browser: ${channel} (headless=${headless})`);
      return { browser, channel };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('No browser found. Install Chrome or run: npx playwright install chromium\n' + lastErr.message);
}

// ── State ─────────────────────────────────────────────────
const state = {
  phase:          'idle',   // idle | signup | running | done
  format:         'single_elimination',
  players:        [],
  bracket:        null,
  tournamentId:   null,
  activeMatches:  {},       // matchId → { match, workerName, gameName }
  log:            [],

  browser:        null,
  workerBrowser:  null,
  controllerPage: null,
  workerPages:    [],       // [{ page, username, busy }]
  stopChatWatch:  null,
};

// ── Broadcast ─────────────────────────────────────────────
let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }

function emit(type, payload = {}) {
  const entry = { type, ...payload, ts: Date.now() };
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  if (_broadcast) _broadcast(entry);
}

// ── Boot ──────────────────────────────────────────────────
async function boot(accounts) {
  console.log('\n🏆 Tournament Bot booting...');

  const { browser: cb, channel } = await launchBrowser(false);
  state.browser = cb;
  emit('browser_channel', { channel });

  console.log(`  Controller: ${accounts.controller.username}`);
  const ctrlCtx = await cb.newContext();
  const cp      = await ctrlCtx.newPage();
  await ph.navigateToLobby(cp);
  await ph.login(cp, accounts.controller.username, accounts.controller.password);
  state.controllerPage = cp;

  const workerHeadless = process.env.HEADLESS !== 'false';
  const { browser: wb } = await launchBrowser(workerHeadless);
  console.log(`  Workers headless: ${workerHeadless} (run with HEADLESS=false to show worker windows)`);
  state.workerBrowser   = wb;

  for (const acc of accounts.workers) {
    console.log(`  Worker (headless): ${acc.username}`);
    const ctx = await wb.newContext();
    const wp  = await ctx.newPage();
    await ph.navigateToLobby(wp);
    await ph.login(wp, acc.username, acc.password);
    state.workerPages.push({ page: wp, username: acc.username, busy: false });
  }

  state.stopChatWatch = ph.watchLobbyChat(state.controllerPage, handleChatMessage);
  console.log('✅ All accounts ready.\n');
  emit('boot', { workers: state.workerPages.map(w => w.username), channel });
}

// ── Chat handler ──────────────────────────────────────────
function handleChatMessage(username, message) {
  const msg = message.trim();
  if (state.phase === 'signup' && msg.toLowerCase() === cfg.signupKeyword.toLowerCase()) {
    registerPlayer(username); return;
  }
  if (state.phase === 'signup' && msg.toLowerCase() === cfg.leaveKeyword.toLowerCase()) {
    unregisterPlayer(username); return;
  }
  if (state.phase === 'running' && msg.toLowerCase().startsWith(cfg.resultKeyword.toLowerCase() + ' ')) {
    reportWin(msg.slice(cfg.resultKeyword.length + 1).trim(), username); return;
  }
  if (msg.toLowerCase() === '!bracket')   { printBracketToChat(); return; }
  if (msg.toLowerCase() === '!standings') { printStandings();     return; }
}

async function chat(text) {
  await ph.sendLobbyChat(state.controllerPage, text);
  emit('chat_out', { text });
}

// ── Signup ────────────────────────────────────────────────
async function openSignup(format) {
  if (state.phase !== 'idle') return;
  state.phase   = 'signup';
  state.format  = format || cfg.bracketFormat || 'single_elimination';
  state.players = [];
  const totalMs  = cfg.signupDurationMs;
  const mins     = Math.floor(totalMs / 60000);
  const secs     = Math.round((totalMs % 60000) / 1000);
  const timeLabel = mins > 0
    ? (secs > 0 ? `${mins}m ${secs}s` : `${mins} minute${mins > 1 ? 's' : ''}`)
    : `${secs}s`;
  const halfMins  = Math.floor((totalMs / 2) / 60000);
  const halfSecs  = Math.round(((totalMs / 2) % 60000) / 1000);
  const halfLabel = halfMins > 0
    ? (halfSecs > 0 ? `${halfMins}m ${halfSecs}s` : `${halfMins} minute${halfMins > 1 ? 's' : ''}`)
    : `${halfSecs}s`;
  const fmtLabel  = { single_elimination: 'Single Elim', double_elimination: 'Double Elim' }[state.format] || state.format;
  await chat(`🏆 TOURNAMENT SIGNUP [${fmtLabel}]! Type "${cfg.signupKeyword}" to enter. ${timeLabel}! Type "${cfg.leaveKeyword}" to unregister.`);
  emit('phase', { phase: 'signup', format: state.format });

  state._signupStart = Date.now();
  state._signupTimers = [];

  const LONG_SIGNUP_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes
  const REMINDER_INTERVAL_MS     =  5 * 60 * 1000; // every 5 minutes

  if (totalMs > LONG_SIGNUP_THRESHOLD_MS) {
    // For long signups: send a reminder every 5 minutes until close
    let elapsed = 0;
    while (elapsed + REMINDER_INTERVAL_MS < totalMs) {
      elapsed += REMINDER_INTERVAL_MS;
      const reminderMs = elapsed;
      state._signupTimers.push(setTimeout(async () => {
        if (state.phase !== 'signup') return;
        const remaining = totalMs - (Date.now() - state._signupStart);
        const rMins = Math.ceil(remaining / 60000);
        await chat(`⏰ ${rMins} minute${rMins !== 1 ? 's' : ''} left to sign up! ${state.players.length}/${cfg.maxPlayers} registered. Type "${cfg.signupKeyword}" to join!`);
        emit('signup_tick', { remaining, players: state.players.length });
      }, reminderMs));
    }
  } else {
    // For short signups: single reminder at the halfway point
    state._signupTimers.push(setTimeout(async () => {
      if (state.phase !== 'signup') return;
      await chat(`⏰ ${halfLabel} left! ${state.players.length} registered.`);
      emit('signup_tick', { remaining: totalMs / 2, players: state.players.length });
    }, totalMs / 2));
  }

  // Auto-close timer
  state._signupTimers.push(setTimeout(closeSignup, totalMs));

  // Emit a tick every second for the dashboard countdown timer
  state._signupTickInterval = setInterval(() => {
    if (state.phase !== 'signup') { clearInterval(state._signupTickInterval); return; }
    const remaining = Math.max(0, totalMs - (Date.now() - state._signupStart));
    emit('signup_tick', { remaining, players: state.players.length });
  }, 1000);
}

async function registerPlayer(username) {
  if (state.players.includes(username)) return;
  if (state.players.length >= cfg.maxPlayers) {
    await chat(`⚠️ ${username}: tournament full.`); return;
  }
  state.players.push(username);
  emit('player_joined', { username, count: state.players.length });
  await chat(`✅ ${username} joined! (${state.players.length}/${cfg.maxPlayers})`);
  // Auto-close signup when player count reaches max
  if (state.players.length >= cfg.maxPlayers) {
    await chat(`🔒 Tournament full! Closing signup and building bracket...`);
    closeSignup();
  }
}

async function unregisterPlayer(username) {
  if (!state.players.includes(username)) return;
  state.players = state.players.filter(p => p !== username);
  emit('player_left', { username, count: state.players.length });
  await chat(`👋 ${username} left the tournament. (${state.players.length}/${cfg.maxPlayers})`);
}

async function closeSignup() {
  if (state.phase !== 'signup') return;
  if (state._signupTickInterval) {
    clearInterval(state._signupTickInterval);
    state._signupTickInterval = null;
  }
  if (state.players.length < cfg.minPlayers) {
    await chat(`❌ Not enough players (${state.players.length}/${cfg.minPlayers}). Cancelled.`);
    state.phase = 'idle'; emit('phase', { phase: 'idle' }); return;
  }
  await chat(`🔒 Signup closed! ${state.players.length} players.`);
  buildTournament();
}

// ── Build tournament ──────────────────────────────────────
async function buildTournament() {
  // Generate a unique tournament ID
  state.tournamentId = `T-${Date.now()}`;

  switch (state.format) {
    case 'double_elimination':
      state.bracket = B.buildDoubleElim(state.players);
      B.autoByesDouble(state.bracket);
      break;
    default:
      state.bracket = B.buildSingleElim(state.players);
      B.autoByesSingle(state.bracket);
  }

  state.phase = 'running';
  emit('phase',   { phase: 'running', format: state.format });
  emit('bracket', { bracket: state.bracket });

  await chat(`🏆 Bracket ready! ${state.players.length} players · ${state.format.replace(/_/g,' ')}`);

  // Push to leaderboard VPS
  lb.tournamentStart({
    id:      state.tournamentId,
    name:    `Tournament ${new Date().toLocaleDateString()}`,
    format:  state.format,
    players: state.players,
    bracket: state.bracket,
  });

  dispatchReadyMatches();
}

// ── Dispatch all currently playable matches ───────────────
// Announce all matches immediately, then start workers one by one.
// Each worker is started only after the previous one is confirmed
// in 'map lobby' status (visible in player list on controller page).
async function dispatchReadyMatches() {
  const matches = B.readyMatches(state.bracket);
  const pending = matches.filter(m => !state.activeMatches[m.id]);
  if (!pending.length) return;

  // Assign workers and announce all matches upfront
  const assignments = [];
  for (const match of pending) {
    const worker = getFreeWorker();
    if (!worker) {
      await chat(`⚠️ No free worker for ${match.p1} vs ${match.p2}. Use forceWin() to advance manually.`);
      emit('error', { msg: `No free worker for ${match.id}` });
      continue;
    }
    const gameName = `${cfg.gameNamePrefix}_${match.id}`;
    worker.busy = true;
    state.activeMatches[match.id] = { match, workerName: worker.username, gameName };
    assignments.push({ match, worker, gameName });
    // Announce from controller immediately
    await chat(`${worker.username} will host: ${match.p1} vs ${match.p2}`);
    emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username, matchId: match.id });
  }

  if (!assignments.length) return;

  // Start workers sequentially: wait for each to reach 'map lobby'
  // before starting the next one, then all run in parallel from there.
  (async () => {
    for (const { match, worker, gameName } of assignments) {
      // Start this worker's game (non-blocking — runs independently)
      startMatch(match, worker, gameName);

      // Poll the controller's player list until this worker shows 'map lobby'
      // (means the game is created and worker is spectating — safe to start next)
      await waitForWorkerStatus(worker.username, 'map lobby', 60000);
    }
  })();
}

// ── Poll controller page until a worker shows the expected lobby status ──
function waitForWorkerStatus(username, expectedStatus, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    let lastStatus = null;
    const iv = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        console.log(`  [waitForWorkerStatus] Timeout waiting for ${username} to show '${expectedStatus}' (last: ${lastStatus})`);
        resolve(); // timed out — proceed anyway
        return;
      }
      try {
        const s = await ph.getPlayerLobbyStatus(state.controllerPage, username);
        if (s !== lastStatus) {
          console.log(`  [waitForWorkerStatus] ${username}: ${lastStatus} → ${s}`);
          lastStatus = s;
        }
        if (s === expectedStatus) {
          clearInterval(iv);
          console.log(`  [waitForWorkerStatus] ${username} reached '${expectedStatus}' ✓`);
          resolve();
        }
      } catch (_) {}
    }, 1000);
  });
}

function startMatch(match, worker, gameName) {
  const statusCb        = (s) => emit('match_status', { gameName, status: s, worker: worker.username });
  const getPlayerStatus = (name) => ph.getPlayerLobbyStatus(state.controllerPage, name);

  let matchResolved = false;

  // ── Safety monitor ─────────────────────────────────────
  // Polls player and worker statuses every 3s.
  // Only activates after the worker reaches 'match' status (game running).
  // When BOTH players AND the worker are back in 'lobby' after that,
  // the game is over — resolve if worker hasn't already.
  let workerSeenInMatch = false;
  const safetyIv = setInterval(async () => {
    if (matchResolved) { clearInterval(safetyIv); return; }
    try {
      const [s1, s2, sw] = await Promise.all([
        getPlayerStatus(match.p1),
        getPlayerStatus(match.p2),
        getPlayerStatus(worker.username),
      ]);
      console.log(`  [safety] ${match.p1}=${s1} ${match.p2}=${s2} ${worker.username}=${sw}`);

      // Wait until worker is confirmed in 'match' before checking for end
      if (sw === 'match') workerSeenInMatch = true;
      if (!workerSeenInMatch) return;

      const workersBack  = sw === 'lobby' || sw === null;
      const p1Back       = s1 !== 'match';
      const p2Back       = s2 !== 'match';

      if (workersBack && p1Back && p2Back && (s1 !== null || s2 !== null)) {
        clearInterval(safetyIv);
        if (matchResolved) return;
        matchResolved = true;

        // Determine loser — whoever left match first
        // We can't know exact timing here so use status as proxy:
        // null = disconnected (left abruptly), 'lobby' = left cleanly
        // If one is null and other is lobby, null is the disconnecter = loser
        let loser, method;
        if (s1 === null && s2 !== null)      { loser = match.p1; method = 'disconnect'; }
        else if (s2 === null && s1 !== null) { loser = match.p2; method = 'disconnect'; }
        else if (s1 !== 'match' && s2 === 'match') { loser = match.p1; method = 'disconnect'; }
        else if (s2 !== 'match' && s1 === 'match') { loser = match.p2; method = 'disconnect'; }
        else {
          // Both back in lobby — can't determine loser from status alone
          console.log(`  [safety] Both players back in lobby but loser unclear — skipping auto-resolve`);
          await chat(`⚠️ ${match.p1} vs ${match.p2} ended but result unclear. Use Force Win to advance.`);
          worker.busy = false;
          delete state.activeMatches[match.id];
          emit('match_error', { gameName, error: 'result_unclear' });
          return;
        }

        const winner = loser === match.p1 ? match.p2 : match.p1;
        console.log(`  [safety] Auto-resolved: ${winner} wins, ${loser} loses (${method})`);
        const wantsRematch = await offerRematch(match, winner, loser);
        if (wantsRematch) {
          // Re-run the match
          matchResolved = false;
          workerSeenInMatch = false;
          worker.busy = true;
          state.activeMatches[match.id] = { match, workerName: worker.username, gameName };
          emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username, matchId: match.id });
          startMatch(match, worker, gameName);
          return;
        }
        worker.busy = false;
        delete state.activeMatches[match.id];
        await applyResult(match, winner, loser, method, gameName);
      }
    } catch (_) {}
  }, 3000);

  workerMod.hostMatch(
    worker.page, worker.username, gameName, match.p1, match.p2,
    statusCb, getPlayerStatus
  ).then(async result => {
    matchResolved = true;
    clearInterval(safetyIv);

    if (result.method === 'disconnect') {
      // Offer winner a rematch before recording the result
      const wantsRematch = await offerRematch(match, result.winner, result.loser);
      if (wantsRematch) {
        // Reset flags and re-run the match with the same worker
        matchResolved = false;
        workerSeenInMatch = false;
        worker.busy = true;
        state.activeMatches[match.id] = { match, workerName: worker.username, gameName };
        emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username, matchId: match.id });
        startMatch(match, worker, gameName);
        return;
      }
    }

    worker.busy = false;
    delete state.activeMatches[match.id];
    await applyResult(match, result.winner, result.loser, result.method, gameName);
  }).catch(async err => {
    matchResolved = true;
    clearInterval(safetyIv);
    if (worker.busy) worker.busy = false;
    if (state.activeMatches[match.id]) delete state.activeMatches[match.id];

    if (err.message === 'join_timeout') {
      const p1Joined = err.p1Joined;
      const p2Joined = err.p2Joined;

      if (p1Joined && !p2Joined) {
        // Only p1 showed up — p1 wins by default, p2 disqualified
        await chat(`⏰ ${match.p2} didn't join. ${match.p1} wins by default. ${match.p2} is disqualified.`);
        await applyResult(match, match.p1, match.p2, 'no_show', gameName);

      } else if (p2Joined && !p1Joined) {
        // Only p2 showed up — p2 wins by default, p1 disqualified
        await chat(`⏰ ${match.p1} didn't join. ${match.p2} wins by default. ${match.p1} is disqualified.`);
        await applyResult(match, match.p2, match.p1, 'no_show', gameName);

      } else {
        // Nobody joined — both disqualified, find a loser from this round to fill in
        await chat(`⏰ Neither ${match.p1} nor ${match.p2} joined. Both are disqualified.`);
        emit('match_error', { gameName, error: 'no_show_both' });
        // Mark both as eliminated and try to find a replacement from eliminated players
        if (!state.bracket.eliminated) state.bracket.eliminated = [];
        state.bracket.eliminated.push(match.p1, match.p2);
        match.winner = 'BYE';
        match.loser  = 'BYE';
        // Propagate a BYE so the bracket can continue
        const { applyWin } = require('./bracket');
        // Just advance with a bye — next round slot stays TBD
        await chat(`⚠️ This bracket slot will be empty. Use Force Win to assign a replacement if needed.`);
        emit('bracket', { bracket: state.bracket });
        setTimeout(dispatchReadyMatches, 1000);
      }
    } else {
      // Other errors — short message, no raw stack trace
      const reason = (err.message || String(err)).split('\n')[0];
      await chat(`🚨 ${match.p1} vs ${match.p2}: ${reason}. Use Force Win to advance manually.`);
      emit('match_error', { gameName, error: reason });
    }
  });
}

// ── Offer rematch after a disconnect ────────────────────
// Asks the winner in lobby chat if they want a rematch.
// Waits up to 60s for them to type !yes or !no.
// Returns true = rematch, false = confirm the win.
async function offerRematch(match, winner, loser) {
  await chat(
    `❓ ${loser} disconnected. ${winner} — do you want a rematch? ` +
    `Type !yes for a rematch or !no to take the win. (60s to decide)`
  );

  return new Promise(resolve => {
    const winnerLower = winner.toLowerCase();
    const timeout     = setTimeout(() => {
      stopWatch();
      chat(`⏱ No response from ${winner} — win confirmed.`);
      resolve(false);
    }, 60000);

    const stopWatch = ph.watchLobbyChat(state.controllerPage, (username, message) => {
      if (username.toLowerCase() !== winnerLower) return;
      const msg = message.trim().toLowerCase();
      if (msg === '!yes') {
        clearTimeout(timeout);
        stopWatch();
        chat(`🔄 Rematch accepted! Hosting again for ${match.p1} vs ${match.p2}...`);
        resolve(true);
      } else if (msg === '!no') {
        clearTimeout(timeout);
        stopWatch();
        chat(`✅ ${winner} takes the win!`);
        resolve(false);
      }
    });
  });
}

function getFreeWorker() {
  // Always return the first free worker in account order
  // (the order they were added in accounts.json / Settings)
  return state.workerPages.find(w => !w.busy) || null;
}

// ── Apply result ──────────────────────────────────────────
async function applyResult(match, winner, loser, method, gameName) {
  B.applyWin(state.bracket, match, winner);
  // Auto-resolve any BYE matches that became available after this result
  B.resolvePendingByes(state.bracket);

  // Build announcement depending on format
  const fmt    = state.bracket.format;
  let   annMsg = '';

  if (fmt === 'double_elimination') {
    if (match.bracket === 'W') {
      annMsg = `🏆 ${winner} → Winner Bracket | ${loser} → Loser Bracket`;
    } else if (match.bracket === 'L') {
      annMsg = `🏆 ${winner} advances in Loser Bracket | ${loser} eliminated`;
    } else {
      annMsg = `🏆 Champion: ${winner}!`;
    }
  } else {
    annMsg = `🏆 ${winner} advances! ${loser} eliminated.`;
  }

  await chat(annMsg);

  // PM
  await ph.sendPrivateMessage(state.controllerPage, winner, `🏆 You advance! Next match details coming soon.`);
  await ph.sendPrivateMessage(state.controllerPage, loser,  `❌ You lost to ${winner}. ${fmt === 'double_elimination' && match.bracket === 'W' ? 'You drop to the Loser Bracket!' : 'Thanks for playing!'}`);

  emit('match_result', { gameName, winner, loser, method, matchId: match.id });
  emit('bracket',      { bracket: state.bracket });

  // Push match result to leaderboard VPS
  lb.matchResult({
    tournamentId: state.tournamentId,
    matchId:      match.id,
    round:        B.getRoundName(match, state.bracket),
    p1: match.p1, p2: match.p2,
    winner, loser, method,
    bracket: state.bracket,
  });

  // Check tournament complete
  if (B.isComplete(state.bracket)) {
    const champ = B.champion(state.bracket);
    await chat(`🏆🎉 TOURNAMENT OVER! Champion: ${champ}!`);
    await ph.sendPrivateMessage(state.controllerPage, champ, `🥇 You are the TOURNAMENT CHAMPION!`);
    state.phase = 'done';
    emit('phase', { phase: 'done', champion: champ });

    // Determine 2nd and 3rd from eliminated list (last two eliminated = 3rd, 2nd)
    const elim   = [...(state.bracket.eliminated || [])];
    const second = elim[elim.length - 1] || null;
    const third  = elim[elim.length - 2] || null;
    lb.tournamentEnd({ id: state.tournamentId, champion: champ, second, third, bracket: state.bracket });
    return;
  }

  // Dispatch any newly available matches
  setTimeout(dispatchReadyMatches, 1000);
}

// ── Manual win ────────────────────────────────────────────
async function reportWin(winner, reporter) {
  const match = B.readyMatches(state.bracket)
    .find(m => m.p1?.toLowerCase() === winner.toLowerCase() ||
               m.p2?.toLowerCase() === winner.toLowerCase());

  if (!match) {
    await chat(`⚠️ ${reporter}: no active match found for "${winner}".`); return;
  }

  const normalized = [match.p1, match.p2].find(p => p?.toLowerCase() === winner.toLowerCase());
  const loser      = match.p1 === normalized ? match.p2 : match.p1;
  const gameName   = state.activeMatches[match.id]?.gameName || `MANUAL_${match.id}`;
  await applyResult(match, normalized, loser, 'manual', gameName);
}

// ── Bracket to chat ───────────────────────────────────────
async function printBracketToChat() {
  if (!state.bracket) { await chat('No bracket yet.'); return; }
  const fmt = state.bracket.format;

  if (fmt === 'single_elimination') {
    for (const [ri, round] of state.bracket.rounds.entries()) {
      const name = B.getRoundName(round[0], state.bracket);
      const str  = round.map(m => `[${m.p1||'TBD'} vs ${m.p2||'TBD'}${m.winner ? '→'+m.winner : ''}]`).join(' ');
      await chat(`📋 ${name}: ${str}`);
    }
  } else if (fmt === 'double_elimination') {
    await chat(`📋 WB: ${state.bracket.wb.map((r,i) => `R${i+1}(${r.filter(m=>m.winner).length}/${r.length})`).join(' ')}`);
    await chat(`📋 LB: ${state.bracket.lb.map((r,i) => `R${i+1}(${r.filter(m=>m.winner).length}/${r.length})`).join(' ')}`);
    const gf = state.bracket.gf[0];
    await chat(`📋 GF: ${gf.p1||'TBD'} vs ${gf.p2||'TBD'}${gf.winner ? ' → '+gf.winner : ''}`);
  }
}

async function printStandings() {
  if (!state.bracket) { await chat('No tournament in progress.'); return; }

  const elim  = state.bracket.eliminated || [];
  const alive = state.players.filter(p => !elim.includes(p));
  await chat(`🟢 Alive: ${alive.join(', ')||'none'} | 🔴 Out: ${elim.join(', ')||'none'}`);
}

// ── Dashboard API ─────────────────────────────────────────
function getSnapshot() {
  return {
    phase:         state.phase,
    format:        state.format,
    players:       state.players,
    bracket:       state.bracket,
    activeMatches: state.activeMatches,
    workers:       state.workerPages.map(w => ({ username: w.username, busy: w.busy })),
    log:           state.log.slice(-50),
    requiredWorkers: B.requiredWorkers(cfg.maxPlayers),
  };
}

async function dashboardCommand(cmd, args = []) {
  switch (cmd) {
    case 'openSignup':   await openSignup(args[0]);              break;
    case 'closeSignup':  await closeSignup();                    break;
    case 'addPlayer':    await registerPlayer(args[0]);          break;
    case 'removePlayer': await unregisterPlayer(args[0]); break;
    case 'forceWin':     await reportWin(args[0], 'DASHBOARD');  break;
    case 'printBracket': await printBracketToChat();             break;
    case 'standings':    await printStandings();                 break;
    case 'reset':        await doReset();                        break;
    case 'testGG': {
      const w = state.workerPages.find(p => p.username === args[0]);
      if (!w) return { error: `Worker ${args[0]} not found` };
      const fakePlayer = args[1] || 'testplayer';
      await w.page.evaluate((player) => {
        const el = document.getElementById('chatHistorytextContainer');
        if (!el) { console.error('chatHistorytextContainer NOT FOUND on this page'); return 'not_found'; }
        const p = document.createElement('p');
        p.textContent = player + ': [to all] gg';
        el.appendChild(p);
        return 'injected';
      }, fakePlayer).then(r => console.log(`testGG result on ${args[0]}: ${r}`)).catch(e => console.error(e));
      return { ok: true };
    }
    default:             return { error: `Unknown command: ${cmd}` };
  }
  return { ok: true };
}

async function doReset() {
  // Clear any pending signup timers so they don't fire after reset
  if (state._signupTimers) {
    state._signupTimers.forEach(t => clearTimeout(t));
    state._signupTimers = [];
  }
  if (state._signupTickInterval) {
    clearInterval(state._signupTickInterval);
    state._signupTickInterval = null;
  }
  state._signupStart = null;
  state.phase         = 'idle';
  state.players       = [];
  state.bracket       = null;
  state.activeMatches = {};
  state.workerPages.forEach(w => { w.busy = false; });
  emit('phase', { phase: 'idle' });
  emit('reset', {});
}

function isRunning() { return !!state.browser; }

async function shutdown() {
  if (state.stopChatWatch) state.stopChatWatch();
  if (state.browser)       { try { await state.browser.close();       } catch (_) {} state.browser       = null; }
  if (state.workerBrowser) { try { await state.workerBrowser.close(); } catch (_) {} state.workerBrowser = null; }
}

module.exports = { boot, setBroadcast, getSnapshot, dashboardCommand, emit, isRunning, shutdown };
