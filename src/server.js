'use strict';
// server.js is not used in the Electron build —
// the Express server is started directly from main.js.
// This file exists only so the non-Electron path still works.

const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { WebSocketServer } = require('ws');
const controller = require('./controller');

const PORT         = process.env.PORT || 4321;
const CONFIG_PATH  = path.join(__dirname, 'config.js');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'data', 'accounts.json');

function startServer() {
  // Load config overrides (same as Electron build)
  try {
    const overridePath = path.join(__dirname, '..', 'data', 'config-override.json');
    if (fs.existsSync(overridePath)) {
      const overrides = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      const cfg = require('./config');
      Object.assign(cfg, overrides);
      console.log('Loaded config overrides:', overrides);
    }
  } catch (e) { console.warn('Config override load failed:', e.message); }

  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });

  app.use(express.json());

  // ── Basic auth ───────────────────────────────────────────
  function basicAuth(req, res, next) {
    const expectedUser = process.env.ADMIN_USER     || 'admin';
    const expectedPass = process.env.ADMIN_PASSWORD || '';
    if (!expectedPass) {
      return res.status(403).send('Forbidden: ADMIN_PASSWORD env var not set');
    }
    const header = req.headers['authorization'] || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const colon   = decoded.indexOf(':');
      const user    = decoded.slice(0, colon);
      const pass    = decoded.slice(colon + 1);
      if (user === expectedUser && pass === expectedPass) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="LWG Tournament Bot"');
    res.status(401).send('Unauthorized');
  }

  // ── Static paths ─────────────────────────────────────────
  const publicDir      = path.join(__dirname, '..', 'dashboard', 'public');
  const leaderboardDir = path.join(__dirname, '..', 'leaderboard');
  const dashboardHtml  = path.join(publicDir, 'dashboard.html');

  // data.json and live.json — no-cache so scores/bracket are always fresh
  const noCache = { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '-1' };
  app.get('/data.json', (_req, res) => {
    res.set(noCache);
    res.sendFile(path.join(leaderboardDir, 'data.json'));
  });
  app.get('/live.json', (_req, res) => {
    const p = path.join(leaderboardDir, 'live.json');
    if (!fs.existsSync(p)) return res.json({ phase: 'idle', bracket: null });
    res.set(noCache);
    res.sendFile(p);
  });

  // Admin dashboard — password protected
  app.get('/Admin', basicAuth, (_req, res) => res.sendFile(dashboardHtml));
  app.get('/admin', basicAuth, (_req, res) => res.sendFile(dashboardHtml));

  // Protect all /api/* routes with the same credentials
  app.use('/api', basicAuth);

  // Leaderboard static site at root (public, index.html served automatically)
  app.use(express.static(leaderboardDir));

  // ── Accounts ────────────────────────────────
  app.get('/api/accounts', (_req, res) => {
    try {
      res.json(JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')));
    } catch (_) { res.json({}); }
  });

  app.post('/api/accounts', (req, res) => {
    try {
      fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true });
      fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Config ──────────────────────────────────
  app.get('/api/config', (_req, res) => {
    try { res.json(require('./config')); }
    catch (_) { res.json({}); }
  });

  app.post('/api/config', (req, res) => {
    try {
      const cfg = require('./config');
      Object.assign(cfg, req.body);
      const overridePath = path.join(__dirname, '..', 'data', 'config-override.json');
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── State ────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(controller.getSnapshot()));

  // ── Commands ─────────────────────────────────
  app.post('/api/cmd', async (req, res) => {
    const { cmd, args = [] } = req.body;

    if (cmd === 'boot' || cmd === 'reconnect') {
      try {
        if (!fs.existsSync(ACCOUNTS_PATH)) {
          return res.status(400).json({ error: 'No accounts configured yet. Go to ⚙ Settings and save your bot credentials first.' });
        }
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
        if (cmd === 'boot') {
          await controller.boot(accounts);
        } else {
          await controller.dashboardCommand('reconnect', [accounts]);
        }
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
      return;
    }

    try {
      const result = await controller.dashboardCommand(cmd, args);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── WebSocket ────────────────────────────────
  const broadcast = (data) => {
    const msg = JSON.stringify(data);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  };
  controller.setBroadcast(broadcast);

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', ...controller.getSnapshot() }));
  });

  server.listen(PORT, () => console.log(`\n🌐 Dashboard: http://localhost:${PORT}\n`));
}

module.exports = { startServer };

// Auto-start when run directly (node src/server.js)
if (require.main === module) {
  startServer();
}
