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

const PORT         = 3000;
const CONFIG_PATH  = path.join(__dirname, 'config.js');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'accounts.json');

function startServer() {
  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });

  app.use(express.json());

  const publicDir = path.join(__dirname, '..', 'dashboard', 'public');
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ── Accounts ────────────────────────────────
  app.get('/api/accounts', (_req, res) => {
    try {
      res.json(JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')));
    } catch (_) { res.json({}); }
  });

  app.post('/api/accounts', (req, res) => {
    try {
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
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── State ────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(controller.getSnapshot()));

  // ── Commands ─────────────────────────────────
  app.post('/api/cmd', async (req, res) => {
    const { cmd, args = [] } = req.body;

    if (cmd === 'boot') {
      try {
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
        await controller.boot(accounts);
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
