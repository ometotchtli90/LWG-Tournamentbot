'use strict';

const cfg = require('./config');
const ph  = require('./pageHelpers');

// ── Host a single tournament match ────────────────────────
// Returns { winner, loser, method } or throws on fatal error.

async function hostMatch(page, workerName, gameName, p1, p2, onStatus, getPlayerStatus, onResultKnown, cancelToken, replayOpts = {}) {
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
  // Button text format: "MapName [playerCount]" — match exactly on name before the "["
  log(`Selecting map: "${cfg.mapName}"...`);
  const mapBtn = await page.waitForFunction((name) => {
    const btns = [...document.querySelectorAll('button.mapButton, button.mapButtonMod')];
    return btns.find(b => {
      // Get only the first text node (before the <br> and <img>)
      const firstTextNode = [...b.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
      const label = (firstTextNode?.textContent || b.innerText || '').trim();
      // Strip the player count "[N]" suffix and compare
      const mapName = label.replace(/\s*\[\d+\]\s*$/, '').trim();
      return mapName === name;
    }) || null;
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
    // Leave the game lobby via the Back button in #gameLobbyWindow
    try {
      await page.waitForSelector('#gameLobbyWindow #backButton', { timeout: 5000 });
      await page.click('#gameLobbyWindow #backButton');
      await page.waitForTimeout(1000);
    } catch (_) {
      // Fallback: try any backButton
      try { await page.click('#backButton'); await page.waitForTimeout(1000); } catch (_) {}
    }

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
  // Click the chat input directly (worker is spectator, keyboard focus unreliable)
  try {
    await page.waitForTimeout(2000); // let game fully load first
    await page.waitForSelector('#ingameChatInput', { timeout: 5000 });
    await page.click('#ingameChatInput');
    await page.fill('#ingameChatInput', '💡 When you lose, please type "gg" before leaving!');
    await page.keyboard.press('Enter');
    log('gg hint sent in-game.');
  } catch (_) {
    log('Could not send gg hint in-game — continuing.');
  }

  // ── 9. Watch for result ──────────────────────────────────
  log('Watching for result...');
  const result = await watchForResult(page, p1, p2, getPlayerStatus, onResultKnown, cancelToken);
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

  // ── 11. Save replay then close stats screen ──────────────
  log('Saving replay and closing stats screen...');
  try {
    await page.waitForSelector('#statisticsWindow', { timeout: 8000 });

    // ── Download replay ───────────────────────────────────
    const replayBtn = await page.$('#saveReplayButton');
    if (replayBtn && replayOpts.replayDir) {
      try {
        // Build a clean filename: YYYY-MM-DD_Round_P1-vs-P2.lwr
        const date      = new Date().toISOString().slice(0, 10); // 2024-01-15
        const round     = (replayOpts.roundName || 'Match').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-');
        const p1safe    = p1.replace(/[^a-zA-Z0-9_-]/g, '');
        const p2safe    = p2.replace(/[^a-zA-Z0-9_-]/g, '');
        const filename  = `${date}_${round}_${p1safe}-vs-${p2safe}.lwr`;
        const savePath  = require('path').join(replayOpts.replayDir, filename);

        // Set up download listener BEFORE clicking the button
        const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
        await replayBtn.click();
        const download = await downloadPromise;
        await download.saveAs(savePath);
        log(`Replay saved: ${filename}`);
      } catch (re) {
        log(`Replay save failed: ${re.message} — continuing.`);
      }
    } else if (replayBtn) {
      // No replayDir configured — just click to trigger native save dialog (will be ignored headless)
      log('No replay dir configured — skipping replay download.');
    }

    // ── Close stats screen ────────────────────────────────
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
    let lastReminderMin  = 0; // track which minute reminder was last sent

    const iv = setInterval(async () => {
      const elapsed   = Date.now() - start;
      const remaining = timeoutMs - elapsed;

      if (elapsed > timeoutMs) {
        clearInterval(iv);
        Object.values(intruderTimers).forEach(clearTimeout);
        resolve({ ok: false, p1Joined: lastP1, p2Joined: lastP2 });
        return;
      }

      // Send a reminder in game lobby chat every full minute elapsed
      const elapsedMins = Math.floor(elapsed / 60000);
      if (elapsedMins > 0 && elapsedMins !== lastReminderMin) {
        lastReminderMin = elapsedMins;
        const remainMins = Math.ceil(remaining / 60000);
        const joined = [lastP1 ? p1 : null, lastP2 ? p2 : null].filter(Boolean);
        const waiting = [!lastP1 ? p1 : null, !lastP2 ? p2 : null].filter(Boolean);
        const msg = waiting.length
          ? `⏳ Still waiting for ${waiting.join(' and ')} to join. ${remainMins} minute${remainMins !== 1 ? 's' : ''} left.`
          : `⏳ Both players joined — waiting for !ready. ${remainMins} minute${remainMins !== 1 ? 's' : ''} left.`;
        ph.sendGameChat(page, msg).catch(() => {});
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
// Two detection methods run in parallel:
//  1. Chat: "gg" typed by p1 or p2 → that player is the loser
//  2. Status poll: first player whose status leaves 'match' is the loser
//     (catches disconnects and rage-quits without gg)
// getPlayerStatus(name) → 'match' | 'map lobby' | 'lobby' | null
function watchForResult(page, p1, p2, getPlayerStatus, onResultKnown, cancelToken) {
  return new Promise(resolve => {
    const p1l     = p1.toLowerCase(), p2l = p2.toLowerCase();
    let ggLoser   = null;
    let resolved  = false;
    let ggTimer   = null;

    function doResolve(loser, method) {
      if (resolved) return;
      resolved = true;
      // Notify controller IMMEDIATELY — stops safety monitor before worker
      // starts the leave-game sequence, preventing the "result unclear" false alarm.
      if (onResultKnown) onResultKnown();
      stopChat();
      clearInterval(statusIv);
      clearInterval(cancelIv);
      if (ggTimer) clearTimeout(ggTimer);
      const winner = loser.toLowerCase() === p1l ? p2 : p1;
      console.log(`  [watchForResult] Result: ${winner} wins, ${loser} loses (${method})`);
      resolve({ winner, loser, method });
    }

    // ── Cancellation poller ──────────────────────────────
    // Checks the shared cancelToken every 500ms.
    // When the controller calls applyResult (e.g. Force Win), it sets
    // cancelToken.cancelled = true, and this resolves with a 'cancelled' result
    // so the worker promise chain exits without double-applying.
    const cancelIv = cancelToken ? setInterval(() => {
      if (!cancelToken.cancelled) return;
      clearInterval(cancelIv);
      if (resolved) return;
      resolved = true;
      stopChat();
      clearInterval(statusIv);
      if (ggTimer) clearTimeout(ggTimer);
      console.log(`  [watchForResult] Cancelled by controller (Force Win / Override)`);
      resolve({ winner: p1, loser: p2, method: 'cancelled' }); // dummy — controller ignores this
    }, 500) : null;

    // ── Method 1: gg in chat ─────────────────────────────
    const stopChat = ph.watchGameChat(page, (line) => {
      if (!line.trim() || resolved || ggTimer) return;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) return;
      const sender   = line.slice(0, colonIdx).trim().toLowerCase();
      const rest     = line.slice(colonIdx + 1).trim();
      const bracketIdx = rest.lastIndexOf('] ');
      const msgBody  = (bracketIdx >= 0 ? rest.slice(bracketIdx + 2) : rest).trim().toLowerCase();
      console.log(`  [${p1}v${p2}] ${sender}: "${msgBody.slice(0, 60)}"`);
      const isGG = /^gg[^a-z]*$/.test(msgBody);
      if (!isGG) return;
      if (sender === p1l)      ggLoser = p1;
      else if (sender === p2l) ggLoser = p2;
      else return;
      console.log(`  [watchForResult] ${ggLoser} typed gg — resolving in 5s`);
      // Notify controller immediately so safety monitor unsubscribes NOW,
      // before the 5s delay. doResolve will also call onResultKnown but
      // controller handles double-calls gracefully (matchResolved flag).
      if (onResultKnown) onResultKnown();
      // Stop status poll immediately — gg has absolute priority over disconnect detection
      if (statusIv) clearInterval(statusIv);
      ggTimer = setTimeout(() => doResolve(ggLoser, 'gg'), 5000);
    });

    // ── Method 2: status poll via controller page ────────
    // Track when each player was last seen in 'match'
    const lastSeen = { [p1l]: null, [p2l]: null };
    const leftAt   = { [p1l]: null, [p2l]: null };

    const statusIv = getPlayerStatus ? setInterval(async () => {
      if (resolved || ggTimer) { clearInterval(statusIv); return; } // gg already detected — don't override
      try {
        const s1 = await getPlayerStatus(p1);
        const s2 = await getPlayerStatus(p2);
        const now = Date.now();

        // Log status changes
        if (s1 !== lastSeen[p1l]) {
          console.log(`  [status] ${p1}: ${lastSeen[p1l]} → ${s1}`);
          lastSeen[p1l] = s1;
          // If they just left 'match' (or disappeared), record when
          if (s1 !== 'match') leftAt[p1l] = now;
        }
        if (s2 !== lastSeen[p2l]) {
          console.log(`  [status] ${p2}: ${lastSeen[p2l]} → ${s2}`);
          lastSeen[p2l] = s2;
          if (s2 !== 'match') leftAt[p2l] = now;
        }

        // Only trigger if at least one player was confirmed 'match' first
        // (avoids false positives at the start before game loads)
        const bothSeenInGame = lastSeen[p1l] !== null || lastSeen[p2l] !== null;
        if (!bothSeenInGame) return;

        const p1Left = leftAt[p1l] !== null;
        const p2Left = leftAt[p2l] !== null;

        if (p1Left && p2Left) {
          // Both left — whoever left first is the loser
          const loser = leftAt[p1l] <= leftAt[p2l] ? p1 : p2;
          doResolve(loser, 'disconnect');
        } else if (p1Left && !p2Left) {
          doResolve(p1, 'disconnect');
        } else if (p2Left && !p1Left) {
          doResolve(p2, 'disconnect');
        }
      } catch (_) {}
    }, 2000) : null;
  });
}


module.exports = { hostMatch };
