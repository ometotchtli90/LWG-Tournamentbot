'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer } = require('ws');
const controller = require('./controller');

const PORT = 3000;

function startServer() {
  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'dashboard', 'public')));

  // REST: snapshot
  app.get('/api/state', (_req, res) => {
    res.json(controller.getSnapshot());
  });

  // REST: commands
  app.post('/api/cmd', async (req, res) => {
    const { cmd, args = [] } = req.body;
    const result = await controller.dashboardCommand(cmd, args);
    res.json(result);
  });

  // WebSocket: push updates to all connected dashboards
  const broadcast = (data) => {
    const msg = JSON.stringify(data);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  };

  controller.setBroadcast(broadcast);

  wss.on('connection', (ws) => {
    // Send full snapshot on connect
    ws.send(JSON.stringify({ type: 'snapshot', ...controller.getSnapshot() }));
  });

  server.listen(PORT, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${PORT}\n`);
  });
}

module.exports = { startServer };
