'use strict';

const path       = require('path');
const fs         = require('fs');
const controller = require('./controller');
const { startServer } = require('./server');

// ── Load accounts ─────────────────────────────────────────
const accountsPath = path.join(__dirname, '..', 'accounts.json');
if (!fs.existsSync(accountsPath)) {
  console.error('❌ accounts.json not found. Copy accounts.json.example and fill in your credentials.');
  process.exit(1);
}

let accounts;
try {
  accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
} catch (e) {
  console.error('❌ Failed to parse accounts.json:', e.message);
  process.exit(1);
}

if (!accounts.controller?.username || !accounts.controller?.password) {
  console.error('❌ accounts.json is missing controller username/password.');
  process.exit(1);
}

if (!accounts.workers?.length) {
  console.error('❌ accounts.json has no workers defined.');
  process.exit(1);
}

// ── Start ─────────────────────────────────────────────────
(async () => {
  startServer();
  await controller.boot(accounts);

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
})();
