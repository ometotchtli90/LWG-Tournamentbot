'use strict';

const { chromium }   = require('playwright');
const cfg            = require('./config');
const ph             = require('./pageHelpers');
const workerMod      = require('./worker');
const { buildBracket, propagateWinner, autoAdvanceByes,
        getRoundName, getEliminated }  = require('./bracket');

// ── State ─────────────────────────────────────────────────
const state = {
  phase:         'idle',   // idle | signup | running | done
  players:       [],
  bracket:       [],
  currentRound:  0,
  workerRR:      0,        // round-robin counter
  activeMatches: {},       // gameName → { p1, p2, workerName }
  log:           [],       // event log for dashboard

  // Playwright handles
  browser:          null,
  controllerPage:   null,
  workerPages:      [],    // [ { page, username } ]
  stopChatWatch:    null,
};

// ── Event emitter for dashboard WebSocket ─────────────────
let _wsBroadcast = null;
function setBroadcast(fn) { _wsBroadcast = fn; }

function emit(type, payload = {}) {
  const entry = { type, ...payload, ts: Date.now() };
  state.log.push(entry);
  if (state.log.length > 200) state.log.shift();
  if (_wsBroadcast) _wsBroadcast(entry);
}

// ── Boot: launch all browsers and log in ─────────────────
async function boot(accounts) {
  console.log('\n🏆 Tournament Bot booting...');
  state.browser = await chromium.launch({ headless: false });

  // Controller
  console.log(`  Logging in controller: ${accounts.controller.username}`);
  const ctx0 = await state.browser.newContext();
  const cp   = await ctx0.newPage();
  await ph.navigateToLobby(cp);
  await ph.login(cp, accounts.controller.username, accounts.controller.password);
  state.controllerPage = cp;

  // Workers
  for (const acc of accounts.workers) {
    console.log(`  Logging in worker: ${acc.username}`);
    const ctx = await state.browser.newContext();
    const wp  = await ctx.newPage();
    await ph.navigateToLobby(wp);
    await ph.login(wp, acc.username, acc.password);
    state.workerPages.push({ page: wp, username: acc.username, busy: false });
  }

  // Start watching lobby chat on controller page
  state.stopChatWatch = ph.watchLobbyChat(state.controllerPage, handleChatMessage);

  console.log('✅ All accounts ready.\n');
  emit('boot', { workers: state.workerPages.map(w => w.username) });
}

// ── Chat handler ──────────────────────────────────────────
function handleChatMessage(username, message) {
  const msg = message.trim();

  if (state.phase === 'signup' && msg.toLowerCase() === cfg.signupKeyword.toLowerCase()) {
    registerPlayer(username);
    return;
  }

  if (state.phase === 'running' && msg.toLowerCase().startsWith(cfg.resultKeyword.toLowerCase() + ' ')) {
    const winner = msg.slice(cfg.resultKeyword.length + 1).trim();
    reportWin(winner, username);
    return;
  }

  if (msg.toLowerCase() === '!bracket')   { printBracketToChat(); return; }
  if (msg.toLowerCase() === '!standings') { printStandings();     return; }
}

// ── Lobby chat shortcut ───────────────────────────────────
async function chat(text) {
  await ph.sendLobbyChat(state.controllerPage, text);
  emit('chat_out', { text });
}

// ── Signup ────────────────────────────────────────────────
async function openSignup() {
  if (state.phase !== 'idle') { emit('error', { msg: 'Tournament already in progress' }); return; }
  state.phase   = 'signup';
  state.players = [];
  const secs    = cfg.signupDurationMs / 1000;

  await chat(`🏆 TOURNAMENT SIGNUP! Type "${cfg.signupKeyword}" to enter. ${secs}s!`);
  emit('phase', { phase: 'signup' });

  setTimeout(async () => {
    await chat(`⏰ ${secs / 2}s left! ${state.players.length} signed up.`);
  }, cfg.signupDurationMs / 2);

  setTimeout(closeSignup, cfg.signupDurationMs);
}

async function registerPlayer(username) {
  if (state.players.includes(username)) { return; }
  if (state.players.length >= cfg.maxPlayers) {
    await chat(`⚠️ ${username}: tournament full.`);
    return;
  }
  state.players.push(username);
  emit('player_joined', { username, count: state.players.length });
  await chat(`✅ ${username} joined! (${state.players.length}/${cfg.maxPlayers})`);
}

async function closeSignup() {
  if (state.phase !== 'signup') return;

  if (state.players.length < cfg.minPlayers) {
    await chat(`❌ Not enough players (${state.players.length}/${cfg.minPlayers}). Cancelled.`);
    state.phase = 'idle';
    emit('phase', { phase: 'idle' });
    return;
  }

  await chat(`🔒 Signup closed! ${state.players.length} players. Building bracket...`);
  buildTournament();
}

// ── Tournament build ──────────────────────────────────────
async function buildTournament() {
  state.bracket      = buildBracket(state.players);
  state.currentRound = 0;
  autoAdvanceByes(state.bracket);
  state.phase = 'running';

  emit('phase',   { phase: 'running' });
  emit('bracket', { bracket: state.bracket });

  await chat(`🏆 Bracket ready! ${state.players.length} players, ${state.bracket.length} rounds.`);
  printBracketToChat();
  startCurrentRound();
}

// ── Round management ──────────────────────────────────────
async function startCurrentRound() {
  const round       = state.bracket[state.currentRound];
  const realMatches = round.filter(m => m.p1 !== 'BYE' && m.p2 !== 'BYE' && !m.winner);

  if (!realMatches.length) { advanceRound(); return; }

  const roundName = getRoundName(state.currentRound, state.bracket.length);
  await chat(`⚔️ ${roundName} — ${realMatches.length} match(es). Check your PMs!`);

  for (let i = 0; i < realMatches.length; i++) {
    setTimeout(() => dispatchMatch(realMatches[i]), i * cfg.betweenMatchDelayMs);
  }
}

function advanceRound() {
  state.currentRound++;
  if (state.currentRound < state.bracket.length) {
    setTimeout(startCurrentRound, cfg.betweenMatchDelayMs);
  }
}

// ── Match dispatch ────────────────────────────────────────
async function dispatchMatch(match) {
  const gameName = `${cfg.gameNamePrefix}_R${match.roundIdx + 1}_M${match.matchIdx + 1}`;

  // Pick a free worker
  const worker = getFreeWorker();
  if (!worker) {
    await chat(`⚠️ No free worker for ${match.p1} vs ${match.p2}. Use forceWin() to advance manually.`);
    emit('error', { msg: `No free worker for match ${gameName}` });
    return;
  }

  worker.busy = true;
  state.activeMatches[gameName] = { p1: match.p1, p2: match.p2, workerName: worker.username };
  emit('match_start', { gameName, p1: match.p1, p2: match.p2, worker: worker.username });

  // PM each player individually
  await ph.sendPrivateMessage(state.controllerPage, match.p1,
    `⚔️ Your match: ${match.p1} vs ${match.p2} | Hosted by: ${worker.username}`);
  await ph.sendPrivateMessage(state.controllerPage, match.p2,
    `⚔️ Your match: ${match.p1} vs ${match.p2} | Hosted by: ${worker.username}`);

  // Host the match in the worker's browser
  workerMod.hostMatch(
    worker.page,
    worker.username,
    gameName,
    cfg.gamePassword,
    match.p1,
    match.p2,
    (status) => emit('match_status', { gameName, status, worker: worker.username })
  ).then(async (result) => {
    worker.busy = false;
    delete state.activeMatches[gameName];
    await applyResult(match, result.winner, result.loser, result.method, gameName);
  }).catch(async (err) => {
    worker.busy = false;
    delete state.activeMatches[gameName];
    const reason = err.message || String(err);
    await chat(`🚨 Match ${gameName} failed: ${reason}. Use forceWin() to advance manually.`);
    emit('match_error', { gameName, error: reason });
  });
}

function getFreeWorker() {
  // Round-robin across non-busy workers
  const free = state.workerPages.filter(w => !w.busy);
  if (!free.length) return null;
  const w = free[state.workerRR % free.length];
  state.workerRR++;
  return w;
}

// ── Apply result ──────────────────────────────────────────
async function applyResult(match, winner, loser, method, gameName) {
  match.winner = winner;
  propagateWinner(state.bracket, match);

  const methodLabel = method === 'gg' ? 'conceded' : method === 'disconnect' ? 'disconnected' : 'GG + left';
  await chat(`🏆 ${winner} wins! ${loser} ${methodLabel}.`);

  // PM winner and loser
  await ph.sendPrivateMessage(state.controllerPage, winner,
    `🏆 You advance! Wait for your next match — details coming via PM.`);
  await ph.sendPrivateMessage(state.controllerPage, loser,
    `❌ You've been eliminated by ${winner}. Thanks for playing!`);

  emit('match_result', { gameName, winner, loser, method });
  emit('bracket',      { bracket: state.bracket });

  const round    = state.bracket[state.currentRound];
  const roundDone = round.every(m => m.winner !== null);

  if (roundDone) {
    if (state.currentRound === state.bracket.length - 1) {
      const champion = state.bracket[state.bracket.length - 1][0].winner;
      await chat(`🏆🎉 CHAMPION: ${champion}! Tournament over!`);
      await ph.sendPrivateMessage(state.controllerPage, champion,
        `🥇 You are the TOURNAMENT CHAMPION! Congratulations!`);
      state.phase = 'done';
      emit('phase', { phase: 'done', champion });
    } else {
      advanceRound();
    }
  }
}

// ── Manual win report (from chat or dashboard) ────────────
async function reportWin(winner, reporter) {
  const round = state.bracket[state.currentRound];
  const match = round?.find(m =>
    !m.winner &&
    (m.p1?.toLowerCase() === winner.toLowerCase() ||
     m.p2?.toLowerCase() === winner.toLowerCase())
  );

  if (!match) {
    await chat(`⚠️ ${reporter}: no active match found for "${winner}".`);
    return;
  }

  const normalized = [match.p1, match.p2].find(p => p?.toLowerCase() === winner.toLowerCase());
  const loser      = match.p1 === normalized ? match.p2 : match.p1;
  const gameName   = `${cfg.gameNamePrefix}_R${match.roundIdx + 1}_M${match.matchIdx + 1}`;
  await applyResult(match, normalized, loser, 'manual', gameName);
}

// ── Bracket to chat ───────────────────────────────────────
async function printBracketToChat() {
  for (const [ri, round] of state.bracket.entries()) {
    const name = getRoundName(ri, state.bracket.length);
    const str  = round.map(m => {
      const p1 = m.p1 || 'TBD', p2 = m.p2 || 'TBD';
      return `[${p1} vs ${p2}${m.winner ? ' →' + m.winner : ''}]`;
    }).join(' ');
    await chat(`📋 ${name}: ${str}`);
  }
}

async function printStandings() {
  if (!state.bracket.length) { await chat('No tournament in progress.'); return; }
  const { alive, eliminated } = getEliminated(state.bracket, state.players);
  await chat(`🟢 Alive: ${alive.join(', ') || 'none'} | 🔴 Out: ${eliminated.join(', ') || 'none'}`);
}

// ── Dashboard API ─────────────────────────────────────────
function getSnapshot() {
  return {
    phase:         state.phase,
    players:       state.players,
    bracket:       state.bracket,
    currentRound:  state.currentRound,
    activeMatches: state.activeMatches,
    workers:       state.workerPages.map(w => ({ username: w.username, busy: w.busy })),
    log:           state.log.slice(-50),
  };
}

async function dashboardCommand(cmd, args) {
  switch (cmd) {
    case 'openSignup':   await openSignup();           break;
    case 'closeSignup':  await closeSignup();          break;
    case 'addPlayer':    await registerPlayer(args[0]); break;
    case 'removePlayer': state.players = state.players.filter(p => p !== args[0]); emit('players', { players: state.players }); break;
    case 'forceWin':     await reportWin(args[0], 'DASHBOARD'); break;
    case 'printBracket': await printBracketToChat();   break;
    case 'standings':    await printStandings();       break;
    case 'reset':        await doReset();              break;
    default:             return { error: `Unknown command: ${cmd}` };
  }
  return { ok: true };
}

async function doReset() {
  state.phase         = 'idle';
  state.players       = [];
  state.bracket       = [];
  state.currentRound  = 0;
  state.activeMatches = {};
  state.workerPages.forEach(w => { w.busy = false; });
  emit('phase', { phase: 'idle' });
  emit('reset', {});
}

module.exports = { boot, setBroadcast, getSnapshot, dashboardCommand, emit };
