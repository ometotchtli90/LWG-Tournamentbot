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
const scheduler  = require('./scheduler');
const lbExport   = require('./leaderboardExport');

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

  // ── Sync persistent leaderboard master → web-served copy ──
  // data/leaderboard.json  = persistent master (survives redeploys, in Coolify volume)
  // leaderboard/data.json  = web-served copy  (baked into image, but NOT persistent)
  //
  // Coolify mounts /app/data from a host volume, hiding image-baked files there.
  // Two scenarios handled at startup:
  //   A) Master missing   → first deploy, seed master from image copy.
  //   B) Master exists but image has tournament IDs not in master → a deliberate
  //      commit+redeploy updated the image; promote image to master so new data wins.
  //   C) Master is a superset of image → master has live data, keep it.
  try {
    const masterPath = path.join(__dirname, '..', 'data', 'leaderboard.json');
    const imagePath  = path.join(__dirname, '..', 'leaderboard', 'data.json');

    let masterData = null;
    let imageData  = null;
    try { masterData = JSON.parse(fs.readFileSync(masterPath, 'utf8')); } catch (_) {}
    try { imageData  = JSON.parse(fs.readFileSync(imagePath,  'utf8')); } catch (_) {}

    if (!masterData) {
      // Scenario A — first run, seed master from image
      if (imageData) {
        fs.mkdirSync(path.dirname(masterPath), { recursive: true });
        fs.copyFileSync(imagePath, masterPath);
        console.log('  Leaderboard master seeded from image leaderboard/data.json');
      } else {
        console.warn('  No leaderboard data found — starting fresh');
      }
    } else if (imageData) {
      // Scenario B — check if image has tournament IDs that master is missing
      const masterIds  = new Set((masterData.tournaments  || []).map(t => t.id));
      const newInImage = (imageData.tournaments || []).filter(t => !masterIds.has(t.id));
      if (newInImage.length > 0) {
        fs.copyFileSync(imagePath, masterPath);
        console.log(`  Image has ${newInImage.length} new tournament(s) not in master — promoting image to master`);
      }
      // Scenario C — master already has all image tournaments (or more); keep master
    }

    // Sync master → web-served copy (always, so the public site is up to date)
    lbExport.writeDataJson();
    console.log('  Leaderboard data synced to leaderboard/data.json');
  } catch (e) { console.warn('  Leaderboard sync failed:', e.message); }

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

  // Replay file downloads — public, no auth required.
  // Files are stored in data/replays/ (persistent volume) and served by filename.
  // Filename sanitisation prevents directory traversal.
  const replaysDir = path.join(__dirname, '..', 'data', 'replays');
  fs.mkdirSync(replaysDir, { recursive: true }); // ensure dir exists on fresh volume
  app.get('/replays/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!/^[\w\-. ]+\.json$/i.test(filename)) return res.status(400).send('Invalid filename');
    const filePath = path.join(replaysDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Replay not found');
    res.download(filePath, filename); // triggers browser Save-As dialog
  });

  // Public schedule feed — only enabled schedules, no internal fields
  app.get('/schedules.json', (_req, res) => {
    res.set(noCache);
    const schedules = scheduler.listSchedules()
      .filter(s => s.enabled)
      .map(s => ({
        id:             s.id,
        name:           s.name,
        recurrence:     s.recurrence,
        time:           s.time,
        timezone:       s.timezone,
        dayOfWeek:      s.dayOfWeek,
        cronExpr:       s.recurrence === 'custom' ? s.cronExpr : undefined,
        fireAt:         s.recurrence === 'once'   ? s.fireAt   : undefined,
        signupOpenMins: s.signupOpenMins || 10,
        mapPoolSize:    s.mapPoolSize    || 5,
        minPlayers:     s.minPlayers     || 4,
        maxPlayers:     s.maxPlayers     || 16,
        joinWaitMins:   s.joinWaitMins   || 5,
        nextRun:        s.nextRun,
      }));
    res.json(schedules);
  });

  // Admin dashboard — password protected
  app.get('/Admin', basicAuth, (_req, res) => res.sendFile(dashboardHtml));
  app.get('/admin', basicAuth, (_req, res) => res.sendFile(dashboardHtml));

  // Protect all /api/* routes with the same credentials
  app.use('/api', basicAuth);

  // Leaderboard static site at root (public, index.html served automatically)
  app.use(express.static(leaderboardDir));

  // ── Schedules ────────────────────────────────
  app.get('/api/schedules', (_req, res) => {
    res.json(scheduler.listSchedules());
  });

  app.post('/api/schedules', (req, res) => {
    try {
      const sched = scheduler.addSchedule(req.body);
      res.json(sched);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/schedules/:id', (req, res) => {
    try {
      const sched = scheduler.updateSchedule(req.params.id, req.body);
      if (!sched) return res.status(404).json({ error: 'Schedule not found' });
      res.json(sched);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/schedules/:id', (req, res) => {
    try {
      scheduler.deleteSchedule(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
          res.json({ ok: true });
        } else {
          // Reconnect takes 30-60 s — fire-and-forget so the proxy doesn't time out
          controller.dashboardCommand('reconnect', [accounts])
            .catch(e => console.error('[reconnect] Error:', e.message));
          res.json({ ok: true });
        }
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

  // Initialise scheduler (loads persisted schedules and starts cron jobs)
  scheduler.init(controller);

  server.listen(PORT, () => console.log(`\n🌐 Dashboard: http://localhost:${PORT}\n`));

  // ── Graceful shutdown on Docker SIGTERM / Ctrl-C ─────────
  // Without this, Chromium processes are left as orphans when the
  // container stops, accumulating until they consume 100% CPU.
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received — shutting down gracefully...`);
    try {
      if (controller.isRunning && controller.isRunning()) {
        await controller.shutdown();
        console.log('[server] Playwright browsers closed.');
      }
    } catch (e) {
      console.error('[server] Shutdown error:', e.message);
    }
    server.close(() => {
      console.log('[server] HTTP server closed. Exiting.');
      process.exit(0);
    });
    // Force-exit if graceful close takes > 5s
    setTimeout(() => { console.error('[server] Force exit after 5s timeout.'); process.exit(1); }, 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', async (err) => {
    console.error('[server] Uncaught exception:', err);
    await gracefulShutdown('uncaughtException').catch(() => {});
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled rejection:', reason);
    // Don't exit — log only, to avoid killing the server on transient Playwright errors
  });
}

module.exports = { startServer };

// Auto-start when run directly (node src/server.js)
if (require.main === module) {
  startServer();
}
