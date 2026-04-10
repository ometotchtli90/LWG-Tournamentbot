'use strict';

const { chromium } = require('playwright');
const cfg          = require('./config');
const ph           = require('./pageHelpers');
const { isInGame } = require('./pageHelpers');
const workerMod    = require('./worker');
const B            = require('./bracket');
const lb           = require('./leaderboardClient');
const lbExport     = require('./leaderboardExport');

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
  cancelTokens:   {},       // matchId → { cancelled: bool } — shared ref with worker
  matchLog:       [],       // all match results for this tournament (for export)
  replayDir:      null,     // set during boot — folder where replays are saved

  // ── Shared status poller ─────────────────────────────
  // One interval reads the ENTIRE player list once per tick and fans out
  // to all registered match subscribers — instead of N matches each polling separately.
  statusPoller:      null,  // the setInterval handle
  statusSubscribers: {},    // matchId → fn(statusMap) called each tick
  statusCache:       {},    // username.toLowerCase() → last known status
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

// ── Shared status poller ──────────────────────────────────
// Reads the full #playersListOnline DOM once every 1.5s on the controller page.
// All active match monitors subscribe to receive the status map — no per-match polling.
function startSharedPoller() {
  if (state.statusPoller) return; // already running
  state.statusPoller = setInterval(async () => {
    if (!state.controllerPage) return;
    try {
      // Read entire player list in one evaluate call
      const entries = await state.controllerPage.evaluate(() => {
        const list = document.getElementById('playersListOnline');
        if (!list) return [];
        return [...list.querySelectorAll('p.playerListPlayer')].map(p => {
          const name  = p.querySelector('a.playerNameInList')?.innerText?.trim() || null;
          const label = p.querySelector('span.lobbyLabel');
          const status = label ? label.innerText.replace(/[()]/g, '').trim().toLowerCase() : 'lobby';
          return { name, status };
        }).filter(e => e.name);
      });

      // Build fresh status map
      const map = {};
      for (const { name, status } of entries) {
        map[name.toLowerCase()] = status;
      }
      state.statusCache = map;

      // Fan out to all subscribers
      const subs = Object.values(state.statusSubscribers);
      for (const fn of subs) {
        try { fn(map); } catch (_) {}
      }
    } catch (_) {}
  }, 1500);
}

function stopSharedPoller() {
  if (state.statusPoller) {
    clearInterval(state.statusPoller);
    state.statusPoller = null;
  }
  state.statusSubscribers = {};
  state.statusCache = {};
}

// Subscribe a match to the shared poller. Returns an unsubscribe function.
function subscribeStatus(matchId, fn) {
  state.statusSubscribers[matchId] = fn;
  return () => { delete state.statusSubscribers[matchId]; };
}

// Get a player's current status from the cache (instant, no await needed).
function getCachedStatus(username) {
  return state.statusCache[username.toLowerCase()] ?? null;
}

// ── Boot ──────────────────────────────────────────────────
async function boot(accounts) {
  console.log('\n🏆 Tournament Bot booting...');

  // HEADLESS=true/false applies to workers (default: true)
  // CONTROLLER_HEADLESS=true/false applies to the controller browser only
  // (default: same as HEADLESS, set to false to watch via VNC)
  const workersHeadless    = process.env.HEADLESS            !== 'false';
  const controllerHeadless = process.env.CONTROLLER_HEADLESS !== undefined
    ? process.env.CONTROLLER_HEADLESS !== 'false'
    : workersHeadless;

  const { browser: cb, channel } = await launchBrowser(controllerHeadless);
  state.browser = cb;
  emit('browser_channel', { channel });

  console.log(`  Controller: ${accounts.controller.username} (headless=${controllerHeadless})`);
  const ctrlCtx = await cb.newContext();
  const cp      = await ctrlCtx.newPage();
  await ph.navigateToLobby(cp);
  await ph.login(cp, accounts.controller.username, accounts.controller.password);
  state.controllerPage = cp;

  const { browser: wb } = await launchBrowser(workersHeadless);
  console.log(`  Workers headless: ${workersHeadless}`);
  state.workerBrowser   = wb;

  for (const acc of accounts.workers) {
    console.log(`  Worker (headless): ${acc.username}`);
    const ctx = await wb.newContext({ acceptDownloads: true });
    const wp  = await ctx.newPage();
    await ph.navigateToLobby(wp);
    await ph.login(wp, acc.username, acc.password);
    state.workerPages.push({ page: wp, username: acc.username, busy: false });
  }

  state.stopChatWatch = ph.watchLobbyChat(state.controllerPage, handleChatMessage);
  startSharedPoller();

  // Compute replay save directory (userData/replays/)
  try {
    const electron = require('electron');
    const userApp  = electron.app;
    const dataDir  = userApp ? userApp.getPath('userData') : require('path').join(__dirname, '..');
    state.replayDir = require('path').join(dataDir, 'replays');
    require('fs').mkdirSync(state.replayDir, { recursive: true });
    console.log(`  Replay dir: ${state.replayDir}`);
  } catch (e) {
    console.warn('  Could not set up replay dir:', e.message);
  }

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
  if (msg.toLowerCase() === '!commands')  { chat(cfg.COMMANDS_HELP); return; }
}

async function chat(text) {
  await ph.sendLobbyChat(state.controllerPage, text);
  emit('chat_out', { text });
}

// ── Signup ────────────────────────────────────────────────
async function openSignup(format, signupMode) {
  if (state.phase !== 'idle') return;
  state.phase      = 'signup';
  state.format     = format || cfg.bracketFormat || 'single_elimination';
  state.players    = [];

  // ── Signup mode ────────────────────────────────────────
  // 'instant' (default): closes as soon as maxPlayers reached OR timer expires
  // 'timed':  always runs full timer — accepts as many players as possible up to
  //           the worker-capacity maximum, never closes early
  const mode = signupMode === 'timed' ? 'timed' : 'instant';
  state._signupMode = mode;

  // For timed mode: max players = workers * 2 (maximum the bots can handle)
  const effectiveMax = mode === 'timed'
    ? state.workerPages.length * 2
    : cfg.maxPlayers;
  state._signupEffectiveMax = effectiveMax;

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
  const modeLabel = mode === 'timed' ? ` · max ${effectiveMax} players` : '';

  await chat(`🏆 TOURNAMENT SIGNUP [${fmtLabel}${modeLabel}]! Type "${cfg.signupKeyword}" to enter. ${timeLabel}! Type "${cfg.leaveKeyword}" to unregister.`);
  emit('phase', { phase: 'signup', format: state.format, signupMode: mode, effectiveMax });

  state._signupStart  = Date.now();
  state._signupTimers = [];

  const LONG_SIGNUP_THRESHOLD_MS = 20 * 60 * 1000;
  const REMINDER_INTERVAL_MS     =  5 * 60 * 1000;

  if (totalMs > LONG_SIGNUP_THRESHOLD_MS) {
    let elapsed = 0;
    while (elapsed + REMINDER_INTERVAL_MS < totalMs) {
      elapsed += REMINDER_INTERVAL_MS;
      const reminderMs = elapsed;
      state._signupTimers.push(setTimeout(async () => {
        if (state.phase !== 'signup') return;
        const remaining = totalMs - (Date.now() - state._signupStart);
        const rMins = Math.ceil(remaining / 60000);
        await chat(`⏰ ${rMins} minute${rMins !== 1 ? 's' : ''} left to sign up! ${state.players.length}/${effectiveMax} registered. Type "${cfg.signupKeyword}" to join!`);
        emit('signup_tick', { remaining, players: state.players.length });
      }, reminderMs));
    }
  } else {
    state._signupTimers.push(setTimeout(async () => {
      if (state.phase !== 'signup') return;
      await chat(`⏰ ${halfLabel} left! ${state.players.length} registered.`);
      emit('signup_tick', { remaining: totalMs / 2, players: state.players.length });
    }, totalMs / 2));
  }

  // Auto-close timer — always fires for both modes
  state._signupTimers.push(setTimeout(closeSignup, totalMs));

  // Tick for dashboard countdown
  state._signupTickInterval = setInterval(() => {
    if (state.phase !== 'signup') { clearInterval(state._signupTickInterval); return; }
    const remaining = Math.max(0, totalMs - (Date.now() - state._signupStart));
    emit('signup_tick', { remaining, players: state.players.length });
  }, 1000);
}

async function registerPlayer(username) {
  if (/^guest_/i.test(username)) {
    await chat(`❌ ${username}: guests cannot join tournaments. Please log in with a registered account.`);
    return;
  }
  if (state.players.some(p => p.toLowerCase() === username.toLowerCase())) return;
  const effectiveMax = state._signupEffectiveMax || cfg.maxPlayers;
  if (state.players.length >= effectiveMax) {
    await chat(`⚠️ ${username}: tournament full (${effectiveMax} players max).`); return;
  }
  state.players.push(username);
  emit('player_joined', { username, count: state.players.length });
  await chat(`✅ ${username} joined! (${state.players.length}/${effectiveMax})`);
  // Auto-close only in instant mode when full
  if (state._signupMode !== 'timed' && state.players.length >= effectiveMax) {
    await chat(`🔒 Tournament full! Closing signup and building bracket...`);
    closeSignup();
  }
}

async function unregisterPlayer(username) {
  if (!state.players.includes(username)) return;
  state.players = state.players.filter(p => p !== username);
  const effectiveMax = state._signupEffectiveMax || cfg.maxPlayers;
  emit('player_left', { username, count: state.players.length });
  await chat(`👋 ${username} left the tournament. (${state.players.length}/${effectiveMax})`);
}

async function closeSignup() {
  if (state.phase !== 'signup') return;
  if (state._signupTickInterval) {
    clearInterval(state._signupTickInterval);
    state._signupTickInterval = null;
  }
  if (state.players.length < cfg.minPlayers) {
    await chat(`❌ Not enough players (${state.players.length}/${cfg.minPlayers} minimum). Cancelled.`);
    state.phase = 'idle';
    state._signupMode = null;
    state._signupEffectiveMax = null;
    emit('phase', { phase: 'idle' }); return;
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
    state.activeMatches[match.id] = { match, workerName: worker.username, gameName, p1: match.p1, p2: match.p2, matchId: match.id };
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

// ── Poll until a worker shows the expected lobby status ──────
// Now reads from the shared status cache instead of querying the DOM directly.
function waitForWorkerStatus(username, expectedStatus, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    let lastStatus = null;
    const iv = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        console.log(`  [waitForWorkerStatus] Timeout waiting for ${username} to show '${expectedStatus}' (last: ${lastStatus})`);
        resolve();
        return;
      }
      const s = getCachedStatus(username);
      if (s !== lastStatus) {
        console.log(`  [waitForWorkerStatus] ${username}: ${lastStatus} → ${s}`);
        lastStatus = s;
      }
      if (s === expectedStatus) {
        clearInterval(iv);
        console.log(`  [waitForWorkerStatus] ${username} reached '${expectedStatus}' ✓`);
        resolve();
      }
    }, 500);
  });
}

function startMatch(match, worker, gameName) {
  const statusCb = (s) => emit('match_status', { gameName, status: s, worker: worker.username });

  // getPlayerStatus: reads from the shared cache — no extra DOM query per call.
  // 'cpu match' is normalised to 'match' so it doesn't look like a disconnect.
  const getPlayerStatus = (name) => {
    const s = getCachedStatus(name);
    if (s === 'cpu match') return Promise.resolve('match');
    return Promise.resolve(s);
  };

  let matchResolved    = false;
  let workerSeenInMatch = false;

  // Cancel token — shared object reference passed to the worker.
  const cancelToken = { cancelled: false };
  state.cancelTokens[match.id] = cancelToken;

  // Called by worker when result is detected (gg or player-left protocol).
  // Only stops the safety monitor — does NOT set matchResolved.
  // The actual result must still flow through .then() to be applied.
  function onResultKnown() {
    unsubscribe();
  }

  // ── Safety monitor via shared poller ───────────────────
  // Subscribes to the shared 1.5s poller instead of its own setInterval.
  const unsubscribe = subscribeStatus(match.id, async (map) => {
    if (matchResolved) { unsubscribe(); return; }
    try {
      const s1 = map[match.p1.toLowerCase()]       ?? null;
      const s2 = map[match.p2.toLowerCase()]       ?? null;
      const sw = map[worker.username.toLowerCase()] ?? null;

      const p1InGame = isInGame(s1);
      const p2InGame = isInGame(s2);
      const wInGame  = isInGame(sw);

      console.log(`  [safety] ${match.p1}=${s1} ${match.p2}=${s2} ${worker.username}=${sw}`);

      if (wInGame) workerSeenInMatch = true;
      if (!workerSeenInMatch) return;

      const workerBack = !wInGame;
      const p1Back     = !p1InGame;
      const p2Back     = !p2InGame;

      if (workerBack && p1Back && p2Back && (s1 !== null || s2 !== null)) {
        if (matchResolved) { unsubscribe(); return; }
        unsubscribe();
        matchResolved = true;

        let loser, method;
        if      (s1 === null && s2 !== null) { loser = match.p1; method = 'disconnect'; }
        else if (s2 === null && s1 !== null) { loser = match.p2; method = 'disconnect'; }
        else if (p1Back && !p2Back)          { loser = match.p1; method = 'disconnect'; }
        else if (p2Back && !p1Back)          { loser = match.p2; method = 'disconnect'; }
        else {
          console.log(`  [safety] Both players back but loser unclear — skipping auto-resolve`);
          await chat(`⚠️ ${match.p1} vs ${match.p2} ended but result unclear. Use Force Win to advance.`);
          worker.busy = false;
          delete state.activeMatches[match.id];
          delete state.cancelTokens[match.id];
          emit('match_error', { gameName, error: 'result_unclear' });
          return;
        }

        const winner = loser === match.p1 ? match.p2 : match.p1;
        console.log(`  [safety] Auto-resolved: ${winner} wins, ${loser} loses (${method})`);
        const wantsRematch = await offerRematch(match, winner, loser);
        if (wantsRematch) {
          matchResolved    = false;
          workerSeenInMatch = false;
          worker.busy = true;
          state.activeMatches[match.id] = { match, workerName: worker.username, gameName, p1: match.p1, p2: match.p2, matchId: match.id };
          emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username, matchId: match.id });
          startMatch(match, worker, gameName);
          return;
        }
        worker.busy = false;
        delete state.activeMatches[match.id];
        delete state.cancelTokens[match.id];
        await applyResult(match, winner, loser, method, gameName);
      }
    } catch (_) {}
  });

  // Determine series settings from per-format config
  const fmtSettings = (cfg.formatSettings || {})[state.format] || {};
  const mapPool     = fmtSettings.mapPool && fmtSettings.mapPool.length ? fmtSettings.mapPool : [cfg.mapName];
  const bestOf      = fmtSettings.bestOf  || 1;

  workerMod.hostSeries(
    worker.page, worker.username, gameName, match.p1, match.p2,
    mapPool, bestOf,
    statusCb, getPlayerStatus, onResultKnown, cancelToken,
    { replayDir: state.replayDir, matchId: match.id, roundName: B.getRoundName(match, state.bracket) }
  ).then(async result => {
    unsubscribe();
    if (result.method === 'cancelled') return; // Force Win already handled it
    if (matchResolved) return;                 // Safety monitor already resolved it
    matchResolved = true;

    if (result.method === 'disconnect') {
      const wantsRematch = await offerRematch(match, result.winner, result.loser);
      if (wantsRematch) {
        matchResolved    = false;
        workerSeenInMatch = false;
        worker.busy = true;
        state.activeMatches[match.id] = { match, workerName: worker.username, gameName, p1: match.p1, p2: match.p2, matchId: match.id };
        emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username, matchId: match.id });
        startMatch(match, worker, gameName);
        return;
      }
    }

    worker.busy = false;
    delete state.activeMatches[match.id];
    delete state.cancelTokens[match.id];
    await applyResult(match, result.winner, result.loser, result.method, gameName);
  }).catch(async err => {
    unsubscribe();
    matchResolved = true;
    if (worker.busy) worker.busy = false;
    if (state.activeMatches[match.id]) delete state.activeMatches[match.id];
    if (state.cancelTokens[match.id])  delete state.cancelTokens[match.id];

    if (err.message === 'forfeit') {
      const forfeiter = err.forfeiter;
      const winner    = forfeiter === match.p1 ? match.p2 : match.p1;
      await chat(`🏳️ ${forfeiter} forfeited. ${winner} advances.`);
      await applyResult(match, winner, forfeiter, 'forfeit', gameName);
    } else if (err.message === 'join_timeout') {
      const p1Joined = err.p1Joined;
      const p2Joined = err.p2Joined;
      if (p1Joined && !p2Joined) {
        await chat(`⏰ ${match.p2} didn't join. ${match.p1} wins by default. ${match.p2} is disqualified.`);
        await applyResult(match, match.p1, match.p2, 'no_show', gameName);
      } else if (p2Joined && !p1Joined) {
        await chat(`⏰ ${match.p1} didn't join. ${match.p2} wins by default. ${match.p1} is disqualified.`);
        await applyResult(match, match.p2, match.p1, 'no_show', gameName);
      } else {
        await chat(`⏰ Neither ${match.p1} nor ${match.p2} joined. Both are disqualified.`);
        emit('match_error', { gameName, error: 'no_show_both' });
        if (!state.bracket.eliminated) state.bracket.eliminated = [];
        state.bracket.eliminated.push(match.p1, match.p2);
        B.applyWin(state.bracket, match, 'BYE');
        B.resolvePendingByes(state.bracket);
        emit('bracket', { bracket: state.bracket });
        const walkedOver = await checkWalkoverChampion();
        if (!walkedOver) setTimeout(dispatchReadyMatches, 1000);
      }
    } else {
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

// ── Walkover champion check ───────────────────────────────
// After a both-DQ or BYE propagation, scan the bracket to see if
// exactly one real player remains with a clear path to the final.
// If the final match has one real player and the other slot is BYE/null,
// declare that player champion immediately.
// Returns true if a champion was declared (caller should not dispatch more matches).
async function checkWalkoverChampion() {
  if (!state.bracket) return false;
  const fmt = state.bracket.format;

  let finalMatch = null;
  if (fmt === 'single_elimination') {
    const lastRound = state.bracket.rounds[state.bracket.rounds.length - 1];
    finalMatch = lastRound?.[0] || null;
  } else if (fmt === 'double_elimination') {
    finalMatch = state.bracket.gf?.[0] || null;
  }
  if (!finalMatch) return false;

  const p1Real = finalMatch.p1 && finalMatch.p1 !== 'BYE';
  const p2Real = finalMatch.p2 && finalMatch.p2 !== 'BYE';

  // Final already has a winner — nothing to do
  if (finalMatch.winner) return false;

  // Both slots filled with real players — normal final, let it play
  if (p1Real && p2Real) return false;

  // One real player, other slot is BYE or not yet filled.
  // Check whether ANY unfinished match in the bracket still involves a real player
  // — this includes matches that are pending (players not yet filled) as well as
  // immediately-ready ones.  Using only readyMatches() here was the bug: a match
  // like LBR1 (DieTrying vs null) is not "ready" because p2 is still coming from
  // an in-flight WB match, so readyMatches() skipped it and the walkover fired early.
  let allUnfinished;
  if (fmt === 'single_elimination') {
    allUnfinished = state.bracket.rounds.flat();
  } else {
    allUnfinished = [
      ...state.bracket.wb.flat(),
      ...state.bracket.lb.flat(),
      // exclude the final itself — we already know it's incomplete
    ];
  }

  const hasUnfinishedRealMatch = allUnfinished.some(m => {
    if (!m || m.winner !== null) return false;          // already done (including BYE wins)
    if (m === finalMatch) return false;                 // skip the final itself
    // The match involves at least one real player who is still competing
    const has1 = m.p1 && m.p1 !== 'BYE';
    const has2 = m.p2 && m.p2 !== 'BYE';
    return has1 || has2;
  });

  if (hasUnfinishedRealMatch) return false; // real matches still to play — wait

  // The only remaining real player wins by walkover
  const champ = p1Real ? finalMatch.p1 : p2Real ? finalMatch.p2 : null;
  if (!champ) return false;

  console.log(`  [walkover] ${champ} wins by walkover — no real opponents remain`);
  await chat(`🏆🎉 TOURNAMENT OVER! ${champ} wins by walkover — all other players were eliminated or disqualified!`);
  await ph.sendPrivateMessage(state.controllerPage, champ, `🥇 You are the TOURNAMENT CHAMPION! (walkover — all opponents disqualified)`);

  // Mark the final match as complete
  finalMatch.winner = champ;
  finalMatch.loser  = finalMatch.p1 === champ ? (finalMatch.p2 || 'BYE') : (finalMatch.p1 || 'BYE');

  state.phase = 'done';
  emit('phase',   { phase: 'done', champion: champ });
  emit('bracket', { bracket: state.bracket });
  lbExport.writeLiveJson({ bracket: state.bracket, activeMatches: {}, phase: 'done', players: state.players, tournamentName: `Tournament ${new Date().toLocaleDateString()}` });

  const elim   = [...(state.bracket.eliminated || [])];
  const second = elim[elim.length - 1] || null;
  const third  = elim[elim.length - 2] || null;
  lb.tournamentEnd({ id: state.tournamentId, champion: champ, second, third, bracket: state.bracket });
  lbExport.recordTournament({
    id:       state.tournamentId,
    name:     `Tournament ${new Date().toLocaleDateString()}`,
    format:   state.format,
    date:     Date.now(),
    champion: champ, second, third,
    bracket:  state.bracket,
    matchLog: state.matchLog,
    players:  state.players,
    replayDir: state.replayDir,
  });
  return true;
}

// ── Apply result ──────────────────────────────────────────
async function applyResult(match, winner, loser, method, gameName) {
  // If there's an active worker for this match (e.g. Force Win called mid-game),
  // cancel it now so watchForResult stops and doesn't double-apply.
  if (state.cancelTokens[match.id]) {
    state.cancelTokens[match.id].cancelled = true;
    delete state.cancelTokens[match.id];
    console.log(`  [applyResult] Cancelled active worker token for match ${match.id}`);
  }
  // Free the worker if still marked busy for this match
  const activeEntry = state.activeMatches[match.id];
  if (activeEntry) {
    const w = state.workerPages.find(wp => wp.username === activeEntry.workerName);
    if (w) w.busy = false;
    delete state.activeMatches[match.id];
  }
  // Forfeit / no-show: mark loser eliminated BEFORE applyWin so the bracket engine
  // skips the LB drop (double elim) — forfeiting players are fully eliminated immediately.
  const isDisqualified = method === 'forfeit' || method === 'no_show';
  if (isDisqualified && loser && loser !== 'BYE') {
    if (!state.bracket.eliminated) state.bracket.eliminated = [];
    if (!state.bracket.eliminated.includes(loser)) state.bracket.eliminated.push(loser);
  }

  B.applyWin(state.bracket, match, winner);
  // Auto-resolve any BYE matches that became available after this result
  B.resolvePendingByes(state.bracket);

  // Build announcement — skip entirely if winner is BYE (silent propagation)
  const fmt    = state.bracket.format;
  let   annMsg = '';

  if (winner !== 'BYE') {
    if (fmt === 'double_elimination') {
      if (match.bracket === 'W') {
        annMsg = isDisqualified
          ? `🏳️ ${loser} is eliminated. ${winner} advances in the Winner Bracket.`
          : `🏆 ${winner} → Winner Bracket | ${loser} → Loser Bracket`;
      } else if (match.bracket === 'L') {
        annMsg = `🏆 ${winner} advances in Loser Bracket | ${loser} eliminated`;
      } else {
        annMsg = `🏆 Champion: ${winner}!`;
      }
    } else {
      annMsg = `🏆 ${winner} advances! ${loser} eliminated.`;
    }
    await chat(annMsg);
    // PM only real players
    await ph.sendPrivateMessage(state.controllerPage, winner, `🏆 You advance! Next match details coming soon.`);
    if (loser && loser !== 'BYE') {
      await ph.sendPrivateMessage(state.controllerPage, loser, `❌ You lost to ${winner}. ${fmt === 'double_elimination' && match.bracket === 'W' ? 'You drop to the Loser Bracket!' : 'Thanks for playing!'}`);
    }
  }

  emit('match_result', { gameName, winner, loser, method, matchId: match.id });
  emit('bracket',      { bracket: state.bracket });
  lbExport.writeLiveJson({ bracket: state.bracket, activeMatches: state.activeMatches, phase: state.phase, players: state.players, tournamentName: `Tournament ${new Date().toLocaleDateString()}` });

  // Accumulate match log for end-of-tournament export
  if (winner !== 'BYE') {
    state.matchLog.push({
      matchId: match.id,
      round:   B.getRoundName(match, state.bracket),
      p1: match.p1, p2: match.p2,
      winner, loser, method,
    });
  }

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
    if (champ && champ !== 'BYE') {
      await chat(`🏆🎉 TOURNAMENT OVER! Champion: ${champ}!`);
      await ph.sendPrivateMessage(state.controllerPage, champ, `🥇 You are the TOURNAMENT CHAMPION!`);
    }
    state.phase = 'done';
    emit('phase', { phase: 'done', champion: champ });

    // Determine 2nd and 3rd from eliminated list (last two eliminated = 3rd, 2nd)
    const elim   = [...(state.bracket.eliminated || [])];
    const second = elim[elim.length - 1] || null;
    const third  = elim[elim.length - 2] || null;
    lb.tournamentEnd({ id: state.tournamentId, champion: champ, second, third, bracket: state.bracket });
    lbExport.writeLiveJson({ bracket: state.bracket, activeMatches: {}, phase: 'done', players: state.players, tournamentName: `Tournament ${new Date().toLocaleDateString()}` });
    lbExport.recordTournament({
      id:       state.tournamentId,
      name:     `Tournament ${new Date().toLocaleDateString()}`,
      format:   state.format,
      date:     Date.now(),
      champion: champ, second, third,
      bracket:  state.bracket,
      matchLog: state.matchLog,
      players:  state.players,
      replayDir: state.replayDir,
    });
    return;
  }

  // Dispatch any newly available matches, or check for walkover if only BYEs remain
  const walkedOver = await checkWalkoverChampion();
  if (!walkedOver) setTimeout(dispatchReadyMatches, 1000);
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


// ── Override a completed match result ────────────────────
// Undoes the old result and re-applies with the new winner.
// Only safe when the old winner has NOT yet played their next match.
async function overrideResult(matchId, newWinner) {
  if (!state.bracket) return { error: 'No active bracket' };

  // Find the match across all rounds
  let match = null;
  const fmt = state.bracket.format;

  if (fmt === 'single_elimination') {
    for (const round of state.bracket.rounds) {
      match = round.find(m => m.id === matchId) || match;
    }
  } else if (fmt === 'double_elimination') {
    const all = [...state.bracket.wb, ...state.bracket.lb, state.bracket.gf].flat();
    match = all.find(m => m && m.id === matchId) || null;
  }

  if (!match) return { error: `Match ${matchId} not found` };
  if (!match.winner) return { error: 'Match has no result yet — use Force Win instead' };

  const oldWinner = match.winner;
  const oldLoser  = match.loser;
  newWinner = [match.p1, match.p2].find(p => p?.toLowerCase() === newWinner.toLowerCase());
  if (!newWinner) return { error: `${newWinner} is not a player in this match` };
  if (newWinner === oldWinner) return { error: `${newWinner} already won this match` };

  const newLoser  = newWinner === match.p1 ? match.p2 : match.p1;
  const nextRi    = match.roundIdx + 1;
  let nextMatch   = null;

  if (fmt === 'single_elimination' && nextRi < state.bracket.rounds.length) {
    nextMatch = state.bracket.rounds[nextRi][Math.floor(match.matchIdx / 2)];
  } else if (fmt === 'double_elimination' && match.bracket === 'W' && nextRi < state.bracket.wb.length) {
    nextMatch = state.bracket.wb[nextRi][Math.floor(match.matchIdx / 2)];
  }

  // ── Cancel any running matches involving displaced players ─
  // When an override changes who goes where in the bracket, any matches
  // that are already in-progress with the now-wrong players must be
  // stopped immediately so the correct pairings can be started instead.
  const displaced = new Set([oldWinner.toLowerCase(), oldLoser.toLowerCase()]);
  const allBracketMatches = fmt === 'double_elimination'
    ? [...(state.bracket.wb || []), ...(state.bracket.lb || []), ...(state.bracket.gf || [])].flat()
    : (state.bracket.rounds || []).flat();

  for (const [mid, entry] of Object.entries(state.activeMatches)) {
    const bm = allBracketMatches.find(m => m && m.id === mid);
    if (!bm) continue;
    const involves = displaced.has((bm.p1 || '').toLowerCase()) || displaced.has((bm.p2 || '').toLowerCase());
    if (!involves) continue;
    console.log(`[overrideResult] Cancelling active match ${mid} (${bm.p1} vs ${bm.p2}) — players displaced by override`);
    if (state.cancelTokens[mid]) {
      state.cancelTokens[mid].cancelled = true;
      delete state.cancelTokens[mid];
    }
    const w = state.workerPages.find(wp => wp.username === entry.workerName);
    if (w) w.busy = false;
    delete state.activeMatches[mid];
    // Also reset the bracket match so it can be re-queued with correct players
    if (!bm.winner) { bm.winner = null; bm.loser = null; }
  }

  // ── Undo old result ──────────────────────────────────────
  // Remove old winner from the next match slot.
  // If that match was already played, reset it so it can be replayed.
  if (nextMatch) {
    if (nextMatch.p1 === oldWinner) nextMatch.p1 = null;
    if (nextMatch.p2 === oldWinner) nextMatch.p2 = null;
    if (nextMatch.winner) {
      // Cancel any active worker for that match too
      if (state.cancelTokens[nextMatch.id]) {
        state.cancelTokens[nextMatch.id].cancelled = true;
        delete state.cancelTokens[nextMatch.id];
      }
      const nextActiveEntry = state.activeMatches[nextMatch.id];
      if (nextActiveEntry) {
        const w = state.workerPages.find(wp => wp.username === nextActiveEntry.workerName);
        if (w) w.busy = false;
        delete state.activeMatches[nextMatch.id];
      }
      nextMatch.winner = null;
      nextMatch.loser  = null;
      await chat(`⚠️ Downstream match (${nextMatch.p1 || '?'} vs ${nextMatch.p2 || '?'}) was reset — it will need to be replayed.`);
    }
  }

  // For double elim: if old loser was dropped to LB, remove them from LB too
  if (fmt === 'double_elimination' && match.bracket === 'W' && oldLoser && oldLoser !== 'BYE') {
    // Remove old loser from all unplayed LB matches they were seeded into
    const allLb = state.bracket.lb.flat();
    for (const lm of allLb) {
      if (!lm || lm.winner) continue;
      if (lm.p1 === oldLoser) lm.p1 = null;
      if (lm.p2 === oldLoser) lm.p2 = null;
    }
    // Remove from lbDropQueue if still pending
    state.bracket.lbDropQueue = (state.bracket.lbDropQueue || []).filter(d => d.loser !== oldLoser);
  }

  // Remove old loser from eliminated list, add new loser
  state.bracket.eliminated = (state.bracket.eliminated || []).filter(p => p !== oldLoser);

  // Reset match
  match.winner = null;
  match.loser  = null;

  // ── Apply new result ─────────────────────────────────────
  const gameName = `OVERRIDE_${match.id}`;
  await applyResult(match, newWinner, newLoser, 'override', gameName);

  await chat(`🔄 Result override: ${match.p1} vs ${match.p2} → ${newWinner} wins (was ${oldWinner})`);
  return { ok: true };
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
    case 'overrideResult': return await overrideResult(args[0], args[1]);
    case 'downloadData': {
      // Returns the current leaderboard data as JSON for the browser to download.
      // User saves it as data.json and commits it to the repo manually.
      try {
        const d = lbExport.loadData();
        d.updatedAt = Date.now();
        return { ok: true, data: d };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'openSignup':   await openSignup(args[0], args[1]);        break;
    case 'closeSignup':  await closeSignup();                    break;
    case 'addPlayer':    await registerPlayer(args[0]);          break;
    case 'removePlayer': await unregisterPlayer(args[0]); break;
    case 'forceWin':     await reportWin(args[0], 'DASHBOARD');  break;
    case 'reset':        await doReset();                        break;
    case 'reconnect':    await doReconnect(args[0]);             break;
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
  // 1. Cancel all active match workers immediately
  const activeCount = Object.keys(state.cancelTokens).length;
  for (const token of Object.values(state.cancelTokens)) {
    token.cancelled = true;
  }

  // 2. Announce cancellation in lobby chat
  try {
    if (state.controllerPage && activeCount > 0) {
      await ph.sendLobbyChat(state.controllerPage, `🚫 Tournament cancelled! All ongoing matches have been stopped.`);
    } else if (state.controllerPage) {
      await ph.sendLobbyChat(state.controllerPage, `🚫 Tournament cancelled.`);
    }
  } catch (_) {}

  // 3. Tell all busy workers to leave their current game
  await Promise.all(state.workerPages.filter(w => w.busy).map(async w => {
    try {
      // Try the in-game quit sequence first
      await w.page.click('#ingameMenuButton').catch(() => {});
      await w.page.waitForTimeout(600);
      await w.page.click('#optionsQuitButton').catch(() => {});
      await w.page.waitForTimeout(800);
      // Fallback: any visible backButton
      await w.page.click('#backButton').catch(() => {});
    } catch (_) {}
  }));

  // 4. Clear signup timers
  if (state._signupTimers) {
    state._signupTimers.forEach(t => clearTimeout(t));
    state._signupTimers = [];
  }
  if (state._signupTickInterval) {
    clearInterval(state._signupTickInterval);
    state._signupTickInterval = null;
  }

  // 5. Reset tournament state (keep browsers alive so a new tournament can start)
  state._signupStart  = null;
  state.phase         = 'idle';
  state.players       = [];
  state.bracket       = null;
  state.activeMatches = {};
  state.cancelTokens  = {};
  state.matchLog      = [];
  state.workerPages.forEach(w => { w.busy = false; });

  emit('phase', { phase: 'idle' });
  emit('reset', {});
  lbExport.writeLiveJson({ bracket: null, activeMatches: {}, phase: 'idle', players: [] });
}

// ── Reconnect all browsers ─────────────────────────────────
// Closes all browser instances and re-runs the login sequence
// for controller + all workers. Tournament state (bracket, players,
// matchLog) is preserved so the tournament can continue after reconnect.
async function doReconnect(accounts) {
  emit('phase', { phase: 'reconnecting' });

  // Cancel active matches so workers stop mid-game
  for (const token of Object.values(state.cancelTokens)) token.cancelled = true;
  state.cancelTokens  = {};
  state.activeMatches = {};
  state.workerPages.forEach(w => { w.busy = false; });

  // Stop chat watcher and shared poller before closing browsers
  if (state.stopChatWatch) { try { state.stopChatWatch(); } catch (_) {} state.stopChatWatch = null; }
  stopSharedPoller();

  // Close existing browsers
  if (state.browser)       { try { await state.browser.close();       } catch (_) {} state.browser       = null; }
  if (state.workerBrowser) { try { await state.workerBrowser.close(); } catch (_) {} state.workerBrowser = null; }
  state.controllerPage = null;
  state.workerPages    = [];

  // Re-boot with the same accounts
  const workersHeadless    = process.env.HEADLESS            !== 'false';
  const controllerHeadless = process.env.CONTROLLER_HEADLESS !== undefined
    ? process.env.CONTROLLER_HEADLESS !== 'false'
    : workersHeadless;

  const { browser: cb, channel } = await launchBrowser(controllerHeadless);
  state.browser = cb;
  emit('browser_channel', { channel });

  const ctrlCtx = await cb.newContext();
  const cp      = await ctrlCtx.newPage();
  await ph.navigateToLobby(cp);
  await ph.login(cp, accounts.controller.username, accounts.controller.password);
  state.controllerPage = cp;

  const { browser: wb } = await launchBrowser(workersHeadless);
  state.workerBrowser = wb;
  for (const acc of accounts.workers) {
    const ctx = await wb.newContext({ acceptDownloads: true });
    const wp  = await ctx.newPage();
    await ph.navigateToLobby(wp);
    await ph.login(wp, acc.username, acc.password);
    state.workerPages.push({ page: wp, username: acc.username, busy: false });
  }

  state.stopChatWatch = ph.watchLobbyChat(state.controllerPage, handleChatMessage);
  startSharedPoller();

  emit('boot', { workers: state.workerPages.map(w => w.username), channel });

  // Restore phase: if tournament was running/done restore that, otherwise idle
  const restoredPhase = (state.phase === 'reconnecting')
    ? (state.bracket ? 'running' : 'idle')
    : state.phase;
  state.phase = restoredPhase;
  emit('phase', { phase: restoredPhase });

  if (restoredPhase === 'running') {
    await ph.sendLobbyChat(state.controllerPage, `✅ Reconnected! Tournament is still running. Use Force Win or wait for matches to be re-dispatched.`);
    // Re-dispatch any matches that were active before reconnect
    setTimeout(dispatchReadyMatches, 2000);
  }
}

function isRunning() { return !!state.browser; }

async function shutdown() {
  if (state.stopChatWatch) state.stopChatWatch();
  stopSharedPoller();
  if (state.browser)       { try { await state.browser.close();       } catch (_) {} state.browser       = null; }
  if (state.workerBrowser) { try { await state.workerBrowser.close(); } catch (_) {} state.workerBrowser = null; }
}

module.exports = { boot, setBroadcast, getSnapshot, dashboardCommand, emit, isRunning, shutdown, doReconnect };
