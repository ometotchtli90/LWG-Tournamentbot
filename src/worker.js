'use strict';

const cfg = require('./config');
const ph  = require('./pageHelpers');

// ── Host a single tournament match ────────────────────────
// Returns { winner, loser, method } or throws on fatal error.

async function hostMatch(page, workerName, gameName, p1, p2, onStatus) {
  const log    = (msg) => console.log(`  [${workerName}] ${msg}`);
  const status = (s)   => { log(s); onStatus && onStatus(s); };

  log(`Hosting: ${p1} vs ${p2}`);

  // ── Announce in main lobby chat before hosting ────────────
  const waitMins = Math.round(cfg.joinWaitMs / 60000);
  await ph.sendLobbyChat(page,
    `I will host for ${p1} vs ${p2} — waiting ${waitMins} minutes for you to join!`
  );

  // ── 1. Click Create/Play button ─────────────────────────
  log('Clicking Create Game...');
  // Wait up to 30s for the button to be visible (worker may be returning from a previous game)
  await page.waitForSelector('#lobbyCreateButton:not([disabled])', { timeout: 30000 });
  await page.waitForFunction(() => {
    const btn = document.getElementById('lobbyCreateButton');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && window.getComputedStyle(btn).display !== 'none';
  }, { timeout: 30000 });
  await page.click('#lobbyCreateButton');
  await page.waitForTimeout(1500);

  // ── 2. Search for map ────────────────────────────────────
  log(`Searching for map: ${cfg.mapName}`);
  await page.waitForSelector('#mapSearchInput', { timeout: 8000 });
  await page.fill('#mapSearchInput', cfg.mapName);
  await page.dispatchEvent('#mapSearchInput', 'input');
  await page.dispatchEvent('#mapSearchInput', 'change');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // ── 3. Click the map button ──────────────────────────────
  log('Selecting map...');
  const mapBtn = await page.waitForFunction((name) => {
    const btns = [...document.querySelectorAll('button.mapButton')];
    return btns.find(b => b.innerText?.trim().startsWith(name)) || null;
  }, cfg.mapName, { timeout: 8000 });
  await mapBtn.click();
  await page.waitForTimeout(1500);

  // ── 4. (skipped — no game name/password needed, bot kicks wrong players) ──

  // Confirm if button exists
  const confirmBtn = await page.$('#createGameConfirmButton, #createGameBtn');
  if (confirmBtn) { await confirmBtn.click(); await page.waitForTimeout(1500); }

  // ── 5. Wait for spectate button then click ───────────────
  log('Waiting for spectate button...');
  try {
    await page.waitForSelector('#moveMeToSpecBtn', { timeout: 15000 });
    await page.click('#moveMeToSpecBtn');
    log('Spectating ✓');
  } catch (_) {
    throw new Error('moveMeToSpecBtn did not appear within 15s');
  }
  await page.waitForTimeout(800);

  status('waiting_for_players');

  // ── 6. Wait for correct players ─────────────────────────
  log(`Waiting up to ${cfg.joinWaitMs / 60000}m for ${p1} & ${p2}...`);
  const joinResult = await waitForCorrectPlayers(page, workerName, p1, p2, cfg.joinWaitMs, onStatus);
  if (!joinResult.ok) {
    // Leave the hosted game via Back button before throwing
    try {
      await page.waitForSelector('#backButton', { timeout: 5000 });
      await page.click('#backButton');
      await page.waitForTimeout(1000);
    } catch (_) {}

    // Throw a structured error so controller can handle each scenario
    const err = new Error('join_timeout');
    err.p1Joined = joinResult.p1Joined;
    err.p2Joined = joinResult.p2Joined;
    throw err;
  }

  // ── 7. !ready + countdown ────────────────────────────────
  log('Asking for !ready...');
  const READY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  await ph.sendGameChat(page, `${p1} vs ${p2} — type !ready to start`);
  const bothReady = await waitForBothReady(page, p1, p2, READY_TIMEOUT_MS);
  if (!bothReady) await ph.sendGameChat(page, '⚠️ Not all confirmed !ready — starting anyway...');
  // Countdown starts immediately once both players are ready (or timeout)
  for (let i = 5; i >= 1; i--) {
    await ph.sendGameChat(page, `${i}`);
    await page.waitForTimeout(1000);
  }
  await ph.sendGameChat(page, 'FIGHT!');
  await page.waitForTimeout(500);

  // ── 8. Start ─────────────────────────────────────────────
  log('Starting game...');
  await page.waitForSelector('#startButton', { timeout: 5000 });
  await page.click('#startButton');
  await page.waitForTimeout(2000);

  status('game_started');

  // ── Send gg hint via in-game chat ────────────────────────
  // Press Enter to open the in-game chat input, type the message, press Enter to send
  try {
    await page.waitForTimeout(2000); // let game fully load first
    await page.keyboard.press('Enter'); // open chat input
    await page.waitForSelector('#ingameChatInput', { timeout: 3000 });
    await page.fill('#ingameChatInput', '💡 When you lose, please type "gg" before leaving!');
    await page.keyboard.press('Enter'); // send
    log('gg hint sent in-game.');
  } catch (_) {
    log('Could not send gg hint in-game — continuing.');
  }

  // ── 9. Watch for result ──────────────────────────────────
  log('Watching for result...');
  const result = await watchForResult(page, p1, p2);
  log(`Result: winner=${result.winner} method=${result.method}`);

  // ── 10. Leave the game ────────────────────────────────────
  log('Leaving game...');
  try {
    // Click the menu/options button to open the options window
    await page.waitForSelector('#ingameMenuButton', { timeout: 10000 });
    await page.click('#ingameMenuButton');
    await page.waitForTimeout(800);
    // Click the Quit button inside the options window
    await page.waitForSelector('#optionsQuitButton', { timeout: 5000 });
    await page.click('#optionsQuitButton');
    await page.waitForTimeout(1500);
    log('Left game via optionsQuitButton.');
  } catch (_) {
    log('optionsQuitButton not found — trying backButton fallback');
    try { await page.click('#backButton'); await page.waitForTimeout(1500); } catch (_) {}
  }

  // ── 11. Close post-game stats screen if it appears ───────
  log('Closing stats screen...');
  try {
    await page.waitForSelector('#statisticsWindow', { timeout: 8000 });
    const closeBtn = await page.$('#statisticsWindow button.closeButton');
    if (closeBtn) {
      await closeBtn.click();
      log('Stats screen closed.');
      await page.waitForTimeout(800);
    }
  } catch (_) {
    log('No stats screen found, continuing...');
  }

  // ── 12. Wait for lobby to be ready for next game ─────────
  // After leaving a game, the lobby needs time to reinitialise.
  // Wait until #lobbyCreateButton is visible before returning.
  log('Waiting for lobby to be ready...');
  try {
    await page.waitForSelector('#lobbyCreateButton', { timeout: 30000 });
    await page.waitForFunction(() => {
      const btn = document.getElementById('lobbyCreateButton');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(btn).display !== 'none';
    }, { timeout: 30000 });
    log('Lobby ready ✓');
  } catch (_) {
    log('Lobby ready check timed out — proceeding anyway.');
  }
  await page.waitForTimeout(500);

  return result;
}

// ── Wait until exactly p1+p2 fill the slots ──────────────
// Returns { ok: true } or { ok: false, p1Joined: bool, p2Joined: bool }
function waitForCorrectPlayers(page, workerName, p1, p2, timeoutMs, onStatus) {
  return new Promise(resolve => {
    const expected       = new Set([p1.toLowerCase(), p2.toLowerCase()]);
    const intruderTimers = {};
    const start          = Date.now();
    let lastP1 = false, lastP2 = false;

    const iv = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        Object.values(intruderTimers).forEach(clearTimeout);
        resolve({ ok: false, p1Joined: lastP1, p2Joined: lastP2 });
        return;
      }

      let slots;
      try { slots = await ph.getSlotPlayers(page); }
      catch (_) { return; }

      const names = slots.map(s => s.name.toLowerCase());
      lastP1 = names.includes(p1.toLowerCase());
      lastP2 = names.includes(p2.toLowerCase());

      // Kick intruders
      for (const s of slots) {
        const key = s.name.toLowerCase();
        if (!expected.has(key)) {
          if (!intruderTimers[s.name]) {
            console.log(`  [${workerName}] Intruder: ${s.name} — kicking in ${cfg.intruderKickMs / 1000}s`);
            intruderTimers[s.name] = setTimeout(async () => {
              if (s.removeBtn) await ph.kickPlayer(page, s.removeBtn).catch(() => {});
              delete intruderTimers[s.name];
            }, cfg.intruderKickMs);
          }
        } else {
          if (intruderTimers[s.name]) {
            clearTimeout(intruderTimers[s.name]);
            delete intruderTimers[s.name];
          }
        }
      }

      const noIntruders = names.every(n => expected.has(n));
      if (lastP1 && lastP2 && noIntruders) {
        clearInterval(iv);
        Object.values(intruderTimers).forEach(clearTimeout);
        resolve({ ok: true, p1Joined: true, p2Joined: true });
      }
    }, 500);
  });
}

// ── Wait for both players to type !ready ──────────────────
// Watches #lobbyGameChatTextArea — the game lobby chat where players
// type before the game starts. Uses structured username+message parsing.
function waitForBothReady(page, p1, p2, timeoutMs) {
  return new Promise(resolve => {
    const ready = new Set();
    const p1l = p1.toLowerCase(), p2l = p2.toLowerCase();
    const start = Date.now();

    const stop = ph.watchLobbyGameChat(page, (username, message) => {
      const uLower = username.toLowerCase();
      const mLower = message.toLowerCase();
      // Player must send the message themselves (match by username)
      if (uLower === p1l && mLower.includes('!ready')) ready.add(p1l);
      if (uLower === p2l && mLower.includes('!ready')) ready.add(p2l);
    });

    const iv = setInterval(() => {
      if (ready.size >= 2 || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        stop();
        resolve(ready.size >= 2);
      }
    }, 500);
  });
}

// ── Watch for game result ────────────────────────────────
// LWG console format: "Chat msg PlayerName: [to all] messagetext"
// We extract the sender name and message body separately,
// then check if the sender is p1 or p2 and if the body is "gg".
function watchForResult(page, p1, p2) {
  return new Promise(resolve => {
    const p1l    = p1.toLowerCase(), p2l = p2.toLowerCase();
    let ggLoser  = null;
    let timer    = null;
    let resolved = false;

    function doResolve() {
      if (resolved) return;
      resolved = true;
      stopWatch();
      const loser  = ggLoser || p2;
      const winner = loser.toLowerCase() === p1l ? p2 : p1;
      resolve({ winner, loser, method: 'gg' });
    }

    const stopWatch = ph.watchGameChat(page, (line) => {
      if (!line.trim() || resolved || timer) return;

      // Parse: "PlayerName: [to all] messagetext"
      // Sender is everything before the first ":"
      const colonIdx   = line.indexOf(':');
      if (colonIdx < 0) return;
      const sender     = line.slice(0, colonIdx).trim().toLowerCase();
      const rest       = line.slice(colonIdx + 1).trim(); // "[to all] messagetext"

      // Extract message body — after the last "] "
      const bracketIdx = rest.lastIndexOf('] ');
      const msgBody    = bracketIdx >= 0 ? rest.slice(bracketIdx + 2).trim().toLowerCase() : rest.trim().toLowerCase();

      console.log(`  [${p1}v${p2}] ${sender}: "${msgBody.slice(0, 60)}"`);

      // Check if message is "gg" (allow "gg!", "gg.", "gg " etc but not "eggs")
      const isGG = /^gg[^a-z]*$/.test(msgBody);
      if (!isGG) return;

      // Check who sent it — must be p1 or p2, first one to write wins
      if (sender === p1l)      ggLoser = p1;
      else if (sender === p2l) ggLoser = p2;
      else return; // someone else typed gg — ignore

      console.log(`  [watchForResult] ${ggLoser} typed gg — they lose. Leaving in 5s.`);
      timer = setTimeout(doResolve, 5000);
    });
  });
}


module.exports = { hostMatch };
