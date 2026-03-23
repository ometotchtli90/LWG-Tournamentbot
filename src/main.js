'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// ── Paths ─────────────────────────────────────────────────
// userData is the OS-appropriate app data folder:
//   Windows: %APPDATA%\lwg-tournament-bot
//   macOS:   ~/Library/Application Support/lwg-tournament-bot
//   Linux:   ~/.config/lwg-tournament-bot
const ACCOUNTS_PATH = path.join(app.getPath('userData'), 'accounts.json');
const PORT = 3000;

let mainWindow   = null;
let wss          = null;
let wsBroadcast  = null;
let serverStarted = false;

// ── Default accounts template ─────────────────────────────
const DEFAULT_ACCOUNTS = {
  controller: { username: 'TourneyMaster', password: '' },
  workers: [
    { username: 'TourneyBot1', password: '' },
    { username: 'TourneyBot2', password: '' },
    { username: 'TourneyBot3', password: '' },
    { username: 'TourneyBot4', password: '' },
  ],
};

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_PATH)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    }
  } catch (_) {}
  return DEFAULT_ACCOUNTS;
}

function saveAccounts(data) {
  fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Express + WebSocket server ────────────────────────────
// Load persisted config overrides (saved by the settings screen)
function loadConfigOverrides() {
  try {
    const fs       = require('fs');
    const path     = require('path');
    const electron = require('electron');
    const userApp  = electron.app;
    const dataDir  = userApp ? userApp.getPath('userData') : path.join(__dirname, '..');
    const cfgPath  = path.join(dataDir, 'config-override.json');
    if (fs.existsSync(cfgPath)) {
      const overrides = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const cfg = require('./config');
      Object.assign(cfg, overrides);
      console.log('Loaded config overrides:', overrides);
    }
  } catch (e) {
    console.warn('Could not load config overrides:', e.message);
  }
}

function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  loadConfigOverrides();
  const expressApp = express();
  const server     = http.createServer(expressApp);
  wss = new WebSocketServer({ server });

  expressApp.use(express.json());

  const publicDir = path.join(__dirname, '..', 'dashboard', 'public');
  expressApp.use(express.static(publicDir));
  expressApp.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // Accounts API
  expressApp.get('/api/accounts', (_req, res) => res.json(loadAccounts()));
  expressApp.post('/api/accounts', (req, res) => {
    try {
      saveAccounts(req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Config API — reads/writes the live config object
  expressApp.get('/api/config', (_req, res) => {
    try { res.json(require('./config')); }
    catch (_) { res.json({}); }
  });
  expressApp.post('/api/config', (req, res) => {
    try {
      const cfg = require('./config');
      Object.assign(cfg, req.body);

      // Persist to disk so changes survive restarts
      try {
        const fs       = require('fs');
        const path     = require('path');
        const electron = require('electron');
        const userApp  = electron.app;
        const dataDir  = userApp ? userApp.getPath('userData') : path.join(__dirname, '..');
        fs.writeFileSync(path.join(dataDir, 'config-override.json'), JSON.stringify(cfg, null, 2));
      } catch (pe) { console.warn('Config persist failed:', pe.message); }

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Tournament state
  expressApp.get('/api/state', (_req, res) => {
    try {
      const controller = require('./controller');
      res.json(controller.getSnapshot());
    } catch (_) {
      res.json({ phase: 'idle', players: [], bracket: [], currentRound: 0, activeMatches: {}, workers: [], log: [] });
    }
  });

  // Commands
  expressApp.post('/api/cmd', async (req, res) => {
    const { cmd, args = [] } = req.body;

    // Boot command is special — handled here in main
    if (cmd === 'boot') {
      try {
        await bootTournament();
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
      return;
    }

    try {
      const controller = require('./controller');
      const result = await controller.dashboardCommand(cmd, args);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  wsBroadcast = (data) => {
    const msg = JSON.stringify(data);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  };

  wss.on('connection', (ws) => {
    try {
      const controller = require('./controller');
      controller.setBroadcast(wsBroadcast);
      ws.send(JSON.stringify({ type: 'snapshot', ...controller.getSnapshot() }));
    } catch (_) {
      ws.send(JSON.stringify({ type: 'snapshot', phase: 'idle', players: [], bracket: [], currentRound: 0, activeMatches: {}, workers: [], log: [] }));
    }
  });

  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// ── Boot tournament (launch Playwright browsers) ──────────
let booting = false;
async function bootTournament() {
  if (booting) throw new Error('Already booting — please wait');
  booting = true;

  try {
    const accounts = loadAccounts();
    const cfg       = require('./config');

    // ── Validation ────────────────────────────────────────
    if (!accounts.controller?.username || !accounts.controller?.password) {
      throw new Error('Controller account is missing username or password. Go to ⚙ Settings to fix this.');
    }

    const emptyWorkers = (accounts.workers || []).filter(w => !w.username || !w.password);
    if (emptyWorkers.length) {
      throw new Error(`These workers are missing credentials: ${emptyWorkers.map(w => w.username || '(unnamed)').join(', ')}. Check ⚙ Settings.`);
    }

    const needed  = Math.ceil(cfg.maxPlayers / 2);
    const have    = (accounts.workers || []).length;
    if (have < needed) {
      throw new Error(
        `Not enough worker accounts. ` +
        `Max players is set to ${cfg.maxPlayers}, which needs ${needed} workers, ` +
        `but only ${have} are configured. ` +
        `Either add more workers in ⚙ Settings or reduce Max Players.`
      );
    }

    const controller = require('./controller');
    controller.setBroadcast(wsBroadcast);

    // Configure leaderboard client if URL is set
    if (accounts.leaderboard?.url) {
      const lb = require('./leaderboardClient');
      lb.configure(accounts.leaderboard.url, accounts.leaderboard.secret);
      console.log(`  Leaderboard: ${accounts.leaderboard.url}`);
    }

    await controller.boot(accounts);
  } finally {
    // Always reset the flag so the button works again after errors
    booting = false;
  }
}

// ── Create main window ────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  900,
    minHeight: 600,
    title: 'LWG Tournament Bot',
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    // Use platform frame on all OSes for simplicity
    frame: true,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open external links in real browser, not Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────
app.whenReady().then(() => {
  startServer();
  // Wait for server to be listening before opening window
  setTimeout(createWindow, 800);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep process alive until Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    const controller = require('./controller');
    if (controller.isRunning && controller.isRunning()) {
      await controller.shutdown();
    }
  } catch (_) {}
});
