'use strict';
// ── Page helpers for a single LWG browser page ───────────

const LWG_URL = 'https://www.littlewargame.com/play/';

async function navigateToLobby(page) {
  await page.goto(LWG_URL, { waitUntil: 'networkidle' });
}

// ── Dismiss first-visit popups ────────────────────────────
// LWG shows two popups on fresh load:
//  1. #patches-container (changelog) — dismissed by clicking anywhere outside it
//  2. #infoWindow (Patreon support) — must click .closeButton to dismiss
async function dismissPopups(page) {
  // Step 1: Dismiss the #changelogDiv overlay.
  // Structure: #changelogDiv > #changelogContents (the actual content)
  // Clicking outside #changelogContents but on #changelogDiv dismisses it.
  // Simplest reliable approach: just force-hide it via JS.
  console.log('    Dismissing changelog...');
  try {
    await page.waitForSelector('#changelogDiv', { timeout: 10000 });
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const div = document.getElementById('changelogDiv');
      if (div) {
        // Force hide — same effect as clicking outside
        div.style.display = 'none';
        div.style.visibility = 'hidden';
        div.style.opacity = '0';
        div.style.pointerEvents = 'none';
      }
    });

    console.log('    Changelog hidden.');
  } catch (_) {
    console.log('    No changelog found, continuing...');
  }
  await page.waitForTimeout(300);

  // Step 2: Close the Patreon infoWindow if it's visible
  try {
    const infoWindow = await page.$('#infoWindow');
    if (infoWindow) {
      // Click the X close button inside #infoWindow
      const closeBtn = await infoWindow.$('button.closeButton');
      if (closeBtn) {
        await closeBtn.click();
        console.log('    Closed Patreon popup.');
        await page.waitForTimeout(400);
      }
    }
  } catch (_) {}

  // Step 3: Safety net — close any remaining .ingameWindow popups
  try {
    const remaining = await page.$$('.ingameWindow button.closeButton');
    for (const btn of remaining) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(200);
      }
    }
  } catch (_) {}

  console.log('    Popups cleared.');
}

// ── Login ─────────────────────────────────────────────────
async function login(page, username, password) {
  console.log(`    [${username}] Dismissing popups...`);
  await dismissPopups(page);

  console.log(`    [${username}] Clicking login button...`);
  await page.waitForSelector('#loginPromptButton', { timeout: 10000 });
  await page.click('#loginPromptButton');

  console.log(`    [${username}] Waiting for login form...`);
  await page.waitForSelector('#loginWindowUsername', { timeout: 10000 });

  console.log(`    [${username}] Filling credentials...`);
  await page.fill('#loginWindowUsername', username);
  await page.fill('#loginWindowPassword', password);
  await page.keyboard.press('Enter');

  console.log(`    [${username}] Waiting for login confirmation...`);
  // waitForFunction(fn, arg, options) — pass null as arg so timeout goes to options
  try {
    await page.waitForFunction(
      () => {
        const el = document.getElementById('playerNameDisplay');
        if (!el) return false;
        const text = el.innerText || el.textContent || '';
        return text.trim().length > 0 && !text.toLowerCase().includes('guest');
      },
      null,
      { timeout: 60000 }
    );
  } catch (e) {
    // Capture current playerNameDisplay text to help diagnose failures
    const current = await page.$eval('#playerNameDisplay',
      el => el.innerText || el.textContent || '(empty)'
    ).catch(() => '(element not found)');
    throw new Error(`Login timed out for "${username}". playerNameDisplay shows: "${current}". Check credentials in ⚙ Settings.`);
  }
  console.log(`  ✓ Logged in as ${username}`);
}

// ── Get lobby status of a player from the online player list ─
// Returns: 'lobby' | 'map lobby' | 'match' | 'cpu match' | 'editor' | null (not found/offline)
// NOTE: For result-detection purposes, 'cpu match' should be treated the same as 'match'
//       (player is in a game). Use isInGame(status) helper for this.
async function getPlayerLobbyStatus(page, username) {
  return page.evaluate((name) => {
    const list = document.getElementById('playersListOnline');
    if (!list) return null;
    for (const p of list.querySelectorAll('p.playerListPlayer')) {
      const link = p.querySelector('a.playerNameInList');
      if (link?.innerText?.trim().toLowerCase() === name.toLowerCase()) {
        const label = p.querySelector('span.lobbyLabel');
        if (!label) return 'lobby';
        return label.innerText.replace(/[()]/g, '').trim().toLowerCase();
      }
    }
    return null;
  }, username);
}

// ── Returns true if status means "currently in a game" ───
// Covers match, cpu match, and any future in-game variants.
function isInGame(status) {
  return status === 'match' || status === 'cpu match';
}

// ── Detect own username from page ────────────────────────
async function detectUsername(page) {
  return page.$eval('#playerNameDisplay a', el => el.innerText.trim()).catch(() => null);
}

// ── Send lobby chat message ───────────────────────────────
async function sendLobbyChat(page, text) {
  const chunks = splitMessage(text, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await page.waitForTimeout(400);
    const chunk = chunks[i].replace('55', '5 5');
    // Focus the input, set value, then dispatch Enter on the element directly
    await page.$eval('#lobbyChatInput', (el, val) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Enter', keyCode: 13,
      }));
    }, chunk);
    await page.waitForTimeout(150);
  }
}

// ── Send in-game lobby chat ───────────────────────────────
async function sendGameChat(page, text) {
  const chunks = splitMessage(text, 245);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await page.waitForTimeout(400);
    const chunk = chunks[i].replace('55', '5 5');
    const sent = await page.evaluate((val) => {
      const input = document.getElementById('lobbyGameChatInput')
                 || document.querySelector('input[id*="GameChat"]')
                 || document.querySelector('input[id*="gameChat"]');
      if (!input) return false;
      input.value = val;
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 13 }));
      return true;
    }, chunk);
    if (!sent) console.warn('  sendGameChat: input not found');
  }
}

// ── Send in-game chat (during active match) ───────────────
async function sendIngameChat(page, text) {
  const chunks = splitMessage(text, 200);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await page.waitForTimeout(400);
    const chunk = chunks[i];
    const sent = await page.evaluate((val) => {
      const input = document.getElementById('ingameChatInput')
                 || document.querySelector('input[id*="ingame"]')
                 || document.querySelector('input[id*="Ingame"]');
      if (!input) return false;
      input.focus();
      input.value = val;
      input.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Enter', keyCode: 13,
      }));
      return true;
    }, chunk);
    if (!sent) console.warn('  sendIngameChat: ingameChatInput not found');
    await page.waitForTimeout(200);
  }
}

// ── Send private message ──────────────────────────────────
async function sendPrivateMessage(page, targetPlayer, text) {
  // 1. Find player in online list
  const found = await page.evaluate((target) => {
    const list = document.getElementById('playersListOnline');
    if (!list) return false;
    for (const p of list.querySelectorAll('p.playerListPlayer')) {
      if (p.innerText?.trim().toLowerCase() === target.toLowerCase()) {
        const container = p.closest('div') || p.parentElement;
        const btn = container?.querySelector('button.inlineChatButton')
                 || p.parentElement?.querySelector('button.inlineChatButton');
        if (btn) { btn.click(); return true; }
      }
    }
    return false;
  }, targetPlayer);

  if (!found) {
    console.warn(`  PM: "${targetPlayer}" not found in online list`);
    return false;
  }

  // 2. Wait for chat window
  let chatInput = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    chatInput = await page.evaluate((target) => {
      for (const h2 of document.querySelectorAll('h2.windowTitle')) {
        if (!h2.innerText?.includes(target)) continue;
        const win = h2.closest('.window, .floatingWindow, .chatWindow')
                 || h2.parentElement?.parentElement?.parentElement;
        const input = win?.querySelector('input.queryInput[id^="chatInput"]')
                   || win?.querySelector('input[type="text"].queryInput')
                   || [...document.querySelectorAll('input.queryInput[id^="chatInput"]')].pop();
        if (input) return input.id;
      }
      return null;
    }, targetPlayer);
    if (chatInput) break;
    await page.waitForTimeout(150);
  }

  if (!chatInput) {
    console.warn(`  PM: chat window for "${targetPlayer}" did not open`);
    return false;
  }

  // 3. Type and send
  const chunks = splitMessage(text, 245);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await page.waitForTimeout(500);
    const chunk = chunks[i].replace('55', '5 5');
    await page.$eval(`#${chatInput}`, (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 13 }));
    }, chunk);
  }

  console.log(`  ✓ PM sent to ${targetPlayer}`);
  return true;
}

// ── Read new chat messages via MutationObserver (returns a stop fn) ──
function watchLobbyChat(page, onMessage) {
  // We poll the chat area every 500ms via page.evaluate and diff against last seen
  let lastCount = 0;
  const iv = setInterval(async () => {
    try {
      const messages = await page.evaluate((since) => {
        const area = document.getElementById('lobbyChatTextArea');
        if (!area) return [];
        const nodes = [...area.querySelectorAll('span[id^="chat"]')];
        return nodes.slice(since).map(node => ({
          username: node.querySelector('a.playerNameInList')?.innerText?.trim() || null,
          message:  (node.querySelector('span:last-child')?.innerText || '').replace(/^:\s*/, '').trim(),
          idx:      nodes.indexOf(node),
        }));
      }, lastCount);

      for (const m of messages) {
        if (m.username && m.message) onMessage(m.username, m.message);
        lastCount = Math.max(lastCount, m.idx + 1);
      }
    } catch (_) {}
  }, 500);

  return () => clearInterval(iv);
}

// ── Watch in-game chat via console message interception ──
// LWG logs every chat message as:
//   "Chat msg PlayerName: [to all] text"
// We intercept this via Playwright's console event listener,
// which is more reliable than polling the DOM.
function watchGameChat(page, onLine, onProtocol) {
  // Intercept LWG's own chat log: "Chat msg PlayerName: [to all] text"
  // This fires instantly when a player sends a message in-game.
  // Also intercept protocol messages (games-list, player-left) from console.error.
  const handler = (msg) => {
    const text = msg.text();

    if (msg.type() === 'log' && text.startsWith('Chat msg ')) {
      onLine(text.slice('Chat msg '.length));
      return;
    }

    // Protocol messages come through as console.error:
    // "main thread error parsing orders msg TYPE<<DATA"
    if (msg.type() === 'error' && text.includes('parsing orders msg ')) {
      const payload = text.replace(/^.*?parsing orders msg /, '');
      const type    = payload.split('<<')[0];
      if (onProtocol) onProtocol(type, payload);
    }
  };
  page.on('console', handler);

  // DOM poller as fallback — only reads #chatHistorytextContainer
  let lastCount = 0;
  const iv = setInterval(async () => {
    try {
      const lines = await page.evaluate((since) => {
        const el = document.getElementById('chatHistorytextContainer');
        if (!el) return [];
        const ps = [...el.querySelectorAll('p')];
        return ps.slice(since).map((p, i) => ({
          text: p.innerText || p.textContent || '',
          idx: since + i,
        }));
      }, lastCount);
      for (const l of lines) {
        if (l.text.trim()) onLine(l.text);
        lastCount = Math.max(lastCount, l.idx + 1);
      }
    } catch (_) {}
  }, 500);

  return () => {
    page.off('console', handler);
    clearInterval(iv);
  };
}

// ── Watch game lobby chat (#lobbyGameChatTextArea) ──────────
// Same structure as main lobby: span[id^="chat"] with a.playerNameInList
function watchLobbyGameChat(page, onMessage) {
  let lastCount = 0;
  const iv = setInterval(async () => {
    try {
      const messages = await page.evaluate((since) => {
        const area = document.getElementById('lobbyGameChatTextArea');
        if (!area) return [];
        const nodes = [...area.querySelectorAll('span[id^="chat"]')];
        return nodes.slice(since).map((node, i) => ({
          username: node.querySelector('a.playerNameInList')?.innerText?.trim() || null,
          message:  (node.querySelector('span:last-child')?.innerText || '').replace(/^:\s*/, '').trim(),
          idx:      since + i,
        }));
      }, lastCount);

      for (const m of messages) {
        if (m.username && m.message) onMessage(m.username, m.message);
        lastCount = Math.max(lastCount, m.idx + 1);
      }
    } catch (_) {}
  }, 300);

  return () => clearInterval(iv);
}

// ── Get players currently in game slots ───────────────────
async function getSlotPlayers(page) {
  return page.evaluate(() => {
    const results = [];
    document.querySelectorAll('ul[id^="playerSlot"]').forEach(slot => {
      slot.querySelectorAll('li[data-name]').forEach(li => {
        const name = li.getAttribute('data-name')?.trim();
        const removeBtn = li.querySelector('button[id^="remove"]')?.id || null;
        if (name) results.push({ name, removeBtn });
      });
    });
    return results;
  });
}

// ── Kick a player by their remove button id ───────────────
async function kickPlayer(page, removeBtnId) {
  await page.evaluate((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.click();
  }, removeBtnId);
}

// ── Utilities ─────────────────────────────────────────────
function splitMessage(text, maxLen) {
  const chunks = [];
  let rem = text;
  while (rem.length > maxLen) {
    let cut = rem.lastIndexOf(' ', maxLen);
    if (cut < 0) cut = maxLen;
    chunks.push(rem.slice(0, cut));
    rem = rem.slice(cut + 1);
  }
  chunks.push(rem);
  return chunks.filter(c => c.length > 0);
}

// ── Wait for map bans from two players in lobby chat ────────
// mapPool: string[]  — all available maps
// p1, p2: string     — the two players who must each ban one map
// timeoutMs: number
// sendMsg: async fn(text) — sends a message to the lobby/game chat
// watchFn: the correct watch function (watchLobbyChat or watchLobbyGameChat)
//
// Returns: { pickedMap: string, bans: { [player]: string } }
function waitForMapBans(page, p1, p2, mapPool, timeoutMs, sendMsg, watchFn) {
  return new Promise((resolve) => {
    const bans    = {};
    const p1l     = p1.toLowerCase();
    const p2l     = p2.toLowerCase();
    const poolLow = mapPool.map(m => m.toLowerCase());

    const stop = watchFn(page, (username, message) => {
      const uLow = username.toLowerCase();
      if (uLow !== p1l && uLow !== p2l) return;           // ignore others
      if (bans[uLow]) return;                              // already banned
      if (!message.toLowerCase().startsWith('!ban ')) return;

      const banArg = message.slice(5).trim().toLowerCase();
      // Find the best match in the pool (exact then startsWith then includes)
      const idx = poolLow.findIndex(m => m === banArg)
               ?? poolLow.findIndex(m => m.startsWith(banArg))
               ?? poolLow.findIndex(m => m.includes(banArg));
      const matched = poolLow.indexOf(banArg) !== -1        ? mapPool[poolLow.indexOf(banArg)]
                    : poolLow.findIndex(m => m === banArg) >= 0 ? mapPool[poolLow.findIndex(m => m === banArg)]
                    : poolLow.findIndex(m => m.startsWith(banArg)) >= 0 ? mapPool[poolLow.findIndex(m => m.startsWith(banArg))]
                    : poolLow.findIndex(m => m.includes(banArg)) >= 0  ? mapPool[poolLow.findIndex(m => m.includes(banArg))]
                    : null;

      if (!matched) {
        sendMsg(`❌ ${username}: "${message.slice(5).trim()}" not found in map pool. Maps: ${mapPool.join(', ')}`).catch(() => {});
        return;
      }
      // Don't let both players ban the same map
      const alreadyBanned = Object.values(bans);
      if (alreadyBanned.map(b => b.toLowerCase()).includes(matched.toLowerCase())) {
        sendMsg(`❌ ${username}: ${matched} is already banned. Pick another map.`).catch(() => {});
        return;
      }

      bans[uLow] = matched;
      sendMsg(`✅ ${username} bans ${matched}.`).catch(() => {});

      if (Object.keys(bans).length >= 2) {
        clearTimeout(deadline);
        stop();
        const remaining = mapPool.filter(m => !Object.values(bans).map(b => b.toLowerCase()).includes(m.toLowerCase()));
        resolve({ pickedMap: remaining[0], bans: { [p1]: bans[p1l], [p2]: bans[p2l] } });
      }
    });

    const deadline = setTimeout(() => {
      stop();
      // Auto-ban for any player who didn't respond
      const remaining = mapPool.filter(m => !Object.values(bans).map(b => b.toLowerCase()).includes(m.toLowerCase()));
      // If only one player banned, auto-pick first remaining for the other
      const pickedMap = remaining[0] || mapPool[0];
      resolve({ pickedMap, bans: { [p1]: bans[p1l] || null, [p2]: bans[p2l] || null }, timedOut: true });
    }, timeoutMs);
  });
}

module.exports = {
  navigateToLobby, login, detectUsername,
  sendLobbyChat, sendGameChat, sendIngameChat, sendPrivateMessage,
  watchLobbyChat, watchLobbyGameChat, watchGameChat,
  getSlotPlayers, kickPlayer, getPlayerLobbyStatus, isInGame,
  waitForMapBans,
};
