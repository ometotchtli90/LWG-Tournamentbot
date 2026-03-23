'use strict';

// ── Leaderboard VPS client ────────────────────────────────
// Set LEADERBOARD_URL and LEADERBOARD_SECRET in environment
// or in accounts.json as { leaderboard: { url, secret } }
// If not configured, all calls are silently no-ops.

let _url    = process.env.LEADERBOARD_URL    || '';
let _secret = process.env.LEADERBOARD_SECRET || '';

function configure(url, secret) {
  _url    = (url    || '').replace(/\/$/, '');
  _secret = secret  || '';
}

async function post(path, body) {
  if (!_url || !_secret) return; // not configured — silent no-op
  try {
    const res = await fetch(`${_url}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': _secret },
      body:    JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[leaderboard] ${path} → ${res.status}`);
  } catch (e) {
    console.warn(`[leaderboard] ${path} failed:`, e.message);
  }
}

// Call when bracket is built
async function tournamentStart({ id, name, format, players, bracket }) {
  await post('/api/tournament/start', { id, name, format, players, bracket });
}

// Call after every match result
async function matchResult({ tournamentId, matchId, round, p1, p2, winner, loser, method, bracket }) {
  await post('/api/match/result', { tournamentId, matchId, round, p1, p2, winner, loser, method, bracket });
}

// Call when tournament ends — pass champion, second, third
async function tournamentEnd({ id, champion, second, third, bracket }) {
  await post('/api/tournament/end', { id, champion, second, third, bracket });
}

module.exports = { configure, tournamentStart, matchResult, tournamentEnd };
