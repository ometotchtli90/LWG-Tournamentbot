#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════
// LWG Leaderboard — GitHub Webhook Receiver
// ══════════════════════════════════════════════════════════
//
// Listens for GitHub push events and runs `git pull` so the
// server always serves the latest index.html + data.json.
//
// SETUP (one-time on your server):
//
//   1. Clone your repo into the web root:
//        git clone https://github.com/YOU/REPO.git /var/www/lwg
//
//   2. Install Node + this script:
//        cp webhook.js /var/www/lwg/webhook.js
//        cd /var/www/lwg
//        npm init -y
//
//   3. Set your webhook secret (pick any random string):
//        export WEBHOOK_SECRET="your-secret-here"
//
//   4. Run with PM2 so it survives reboots:
//        npm install -g pm2
//        pm2 start webhook.js --name lwg-webhook
//        pm2 save
//        pm2 startup
//
//   5. In GitHub repo → Settings → Webhooks → Add webhook:
//        Payload URL:   http://YOUR_SERVER_IP:9000/webhook
//        Content type:  application/json
//        Secret:        your-secret-here (same as above)
//        Events:        Just the push event
//
//   6. Point your web server (nginx/apache) at /var/www/lwg
//      for the leaderboard, and proxy :9000 for the webhook.
//
// NGINX CONFIG EXAMPLE:
//
//   server {
//     listen 80;
//     server_name yourdomain.com;
//
//     # Leaderboard static site
//     root /var/www/lwg;
//     index index.html;
//     location / { try_files $uri $uri/ =404; }
//
//     # Webhook receiver
//     location /webhook {
//       proxy_pass http://127.0.0.1:9000/webhook;
//       proxy_set_header X-Real-IP $remote_addr;
//     }
//   }
//
// ══════════════════════════════════════════════════════════

const http   = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path   = require('path');

// ── Config ────────────────────────────────────────────────
const PORT    = process.env.WEBHOOK_PORT   || 9000;
const SECRET  = process.env.WEBHOOK_SECRET || '';
const REPO_DIR = process.env.REPO_DIR || path.resolve(__dirname);
const BRANCH  = process.env.BRANCH || 'main';

if (!SECRET) {
  console.warn('⚠  WEBHOOK_SECRET not set — signature verification disabled!');
  console.warn('   Set it: export WEBHOOK_SECRET="your-secret-here"');
}

// ── Signature verification ────────────────────────────────
function verifySignature(body, signature) {
  if (!SECRET) return true; // skip if no secret configured
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

// ── Run git pull ──────────────────────────────────────────
function gitPull() {
  const out = execSync(
    `git -C "${REPO_DIR}" pull origin ${BRANCH} --ff-only`,
    { stdio: 'pipe', timeout: 30000 }
  ).toString().trim();
  console.log('[webhook] git pull:', out);
  return out;
}

// ── HTTP server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, repo: REPO_DIR, branch: BRANCH }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Verify signature
      const sig = req.headers['x-hub-signature-256'];
      if (!verifySignature(body, sig)) {
        console.warn('[webhook] ❌ Invalid signature — rejected');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      // Only handle push events
      const event = req.headers['x-github-event'];
      if (event !== 'push') {
        res.writeHead(200);
        res.end('Ignored: ' + event);
        return;
      }

      // Parse payload
      let payload;
      try { payload = JSON.parse(body); } catch (_) { payload = {}; }

      const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
      if (pushedBranch !== BRANCH) {
        console.log(`[webhook] Push to ${pushedBranch} — ignoring (watching ${BRANCH})`);
        res.writeHead(200);
        res.end('Ignored: wrong branch');
        return;
      }

      const pusher  = payload.pusher?.name || 'unknown';
      const commits = payload.commits?.length || 0;
      console.log(`[webhook] ✓ Push from ${pusher} (${commits} commit${commits!==1?'s':''}) — pulling...`);

      // Run git pull (respond immediately, pull async)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Pull triggered' }));

      try {
        const out = gitPull();
        console.log('[webhook] ✅ Deploy complete');
      } catch (e) {
        console.error('[webhook] ❌ git pull failed:', e.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔗 LWG Webhook Receiver`);
  console.log(`   Port:      ${PORT}`);
  console.log(`   Repo:      ${REPO_DIR}`);
  console.log(`   Branch:    ${BRANCH}`);
  console.log(`   Secret:    ${SECRET ? '✓ configured' : '⚠ NOT SET'}`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   Endpoint:  http://localhost:${PORT}/webhook\n`);
});
