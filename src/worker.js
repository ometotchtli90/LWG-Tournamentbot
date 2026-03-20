'use strict';

const cfg = require('./config');
const ph  = require('./pageHelpers');

// ── Host a single tournament match ────────────────────────
// Returns { winner, loser, method } or throws on fatal error.

async function hostMatch(page, workerName, gameName, gamePass, p1, p2, onStatus) {
  const log = (msg) => { console.log(`  [${workerName}] ${msg}`); onStatus && onStatus(msg); };

  log(`Hosting: ${p1} vs ${p2}`);

  // ── 1. Click Create/Play button ─────────────────────────
  log('Clicking Create Game...');
  await page.waitForSelector('#lobbyCreateButton', { timeout: 10000 });
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

  // ── 4. Set game name & password ──────────────────────────
  log('Setting game name and password...');
  try {
    await page.waitForSelector('#gameNameInput', { timeout: 5000 });
    await page.fill('#gameNameInput', '');
    await page.fill('#gameNameInput', gameName);
    await page.dispatchEvent('#gameNameInput', 'input');
    await page.dispatchEvent('#gameNameInput', 'change');
  } catch (_) { log('gameNameInput not found — skipping'); }

  try {
    await page.waitForSelector('#gamePWInput', { timeout: 3000 });
    await page.fill('#gamePWInput', '');
    await page.fill('#gamePWInput', gamePass);
    await page.dispatchEvent('#gamePWInput', 'input');
    await page.dispatchEvent('#gamePWInput', 'change');
  } catch (_) { log('gamePWInput not found — skipping'); }

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

  onStatus && onStatus('waiting_for_players');

  // ── 6. Wait for correct players ─────────────────────────
  log(`Waiting up to ${cfg.joinWaitMs / 60000}m for ${p1} & ${p2}...`);
  const playersReady = await waitForCorrectPlayers(page, workerName, p1, p2, cfg.joinWaitMs, onStatus);
  if (!playersReady) {
    await ph.sendGameChat(page, `⏰ Timeout — ${p1} or ${p2} did not join. Match cancelled.`);
    throw new Error('join_timeout');
  }

  // ── 7. !ready + countdown ────────────────────────────────
  log('Asking for !ready...');
  await ph.sendGameChat(page, `${p1} vs ${p2} — type !ready to start (${cfg.readyWaitMs / 1000}s)`);
  const bothReady = await waitForBothReady(page, p1, p2, cfg.readyWaitMs);
  await ph.sendGameChat(page,
    bothReady
      ? '✅ Both ready! 1… 2… 3… 4… 5… FIGHT!'
      : '⚠️ Starting anyway… 1… 2… 3… 4… 5… FIGHT!'
  );
  await page.waitForTimeout(5000);

  // ── 8. Start ─────────────────────────────────────────────
  log('Starting game...');
  await page.waitForSelector('#startButton', { timeout: 5000 });
  await page.click('#startButton');
  await page.waitForTimeout(2000);

  onStatus && onStatus('game_started');

  // ── 9. Watch for result ──────────────────────────────────
  log('Watching for result...');
  const result = await watchForResult(page, p1, p2);
  log(`Result: winner=${result.winner} method=${result.method}`);
  return result;
}

// ── Wait until exactly p1+p2 fill the slots ──────────────
function waitForCorrectPlayers(page, workerName, p1, p2, timeoutMs, onStatus) {
  return new Promise(resolve => {
    const expected      = new Set([p1.toLowerCase(), p2.toLowerCase()]);
    const intruderTimers = {};
    const start          = Date.now();

    const iv = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(false);
        return;
      }

      let slots;
      try { slots = await ph.getSlotPlayers(page); }
      catch (_) { return; }

      const names = slots.map(s => s.name.toLowerCase());

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

      const hasP1      = names.includes(p1.toLowerCase());
      const hasP2      = names.includes(p2.toLowerCase());
      const noIntruders = names.every(n => expected.has(n));

      if (hasP1 && hasP2 && noIntruders) {
        clearInterval(iv);
        Object.values(intruderTimers).forEach(clearTimeout);
        resolve(true);
      }
    }, 500);
  });
}

// ── Wait for both players to type !ready ──────────────────
function waitForBothReady(page, p1, p2, timeoutMs) {
  return new Promise(resolve => {
    const ready = new Set();
    const p1l = p1.toLowerCase(), p2l = p2.toLowerCase();
    const start = Date.now();

    const stop = ph.watchGameChat(page, (line) => {
      const l = line.toLowerCase();
      if (l.includes(p1l) && l.includes('!ready')) ready.add(p1l);
      if (l.includes(p2l) && l.includes('!ready')) ready.add(p2l);
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

// ── Watch for GG or player-left ───────────────────────────
function watchForResult(page, p1, p2) {
  return new Promise(resolve => {
    const p1l = p1.toLowerCase(), p2l = p2.toLowerCase();
    const ggStart = Date.now();
    let ggLoser = null, leaveLoser = null, resolved = false;

    function tryResolve() {
      if (resolved || (!ggLoser && !leaveLoser)) return;
      resolved = true;
      stop();
      const loser  = leaveLoser || ggLoser;
      const winner = loser.toLowerCase() === p1l ? p2 : p1;
      const method = (ggLoser && leaveLoser) ? 'both' : leaveLoser ? 'disconnect' : 'gg';
      resolve({ winner, loser, method });
    }

    const stop = ph.watchGameChat(page, (line) => {
      const lower = line.toLowerCase();

      // GG — first 2 minutes only
      if (!ggLoser && Date.now() - ggStart < cfg.ggWatchMs) {
        if (lower.includes(p1l) && /\bgg\b/.test(lower)) { ggLoser = p1; tryResolve(); }
        else if (lower.includes(p2l) && /\bgg\b/.test(lower)) { ggLoser = p2; tryResolve(); }
      }

      // Player left
      if (!leaveLoser) {
        const m = lower.match(/player\s+(\S+)\s+left/) || lower.match(/\b(\S+)\s+left\b/);
        if (m) {
          if (m[1] === p1l) { leaveLoser = p1; tryResolve(); }
          else if (m[1] === p2l) { leaveLoser = p2; tryResolve(); }
        }
      }
    });
  });
}

module.exports = { hostMatch };
