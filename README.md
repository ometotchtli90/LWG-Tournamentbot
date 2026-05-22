# LWG Tournament Bot

An automated tournament bot for [LittleWarGame.com](https://www.littlewargame.com/play/) that hosts and manages 1v1 tournaments entirely in-browser using Playwright.

The bot creates game lobbies, waits for players to join, runs countdown timers, detects match outcomes, advances the bracket, and publishes a live leaderboard — all without manual intervention.

---

## Features

- **Single Elimination & Double Elimination** bracket formats
- **Best-of-N series** with per-game map rotation
- **Map ban phase** — players ban maps from a pool before a series begins
- **Live public leaderboard** served at your own domain (auto-updated after every match)
- **Admin dashboard** — real-time bracket view, event log, force-win controls
- **Replay archiving** — saves `.json` replay files for every game
- **Player commands** in game lobby chat (`!ready`, `!forfeit`, `!rehost`, `!kick`, etc.)
- **Safety monitor** — auto-resolves disconnects when the bot misses a `gg`
- **Multi-worker** — runs parallel matches with multiple bot accounts

---

## Architecture

```
src/
  server.js            — Express + WebSocket HTTP server (dashboard API, event stream)
  controller.js        — Tournament state machine (signup → bracket → dispatch → result)
  worker.js            — Per-match automation (hostMatch, hostSeries)
  pageHelpers.js       — Playwright DOM helpers (login, chat, slot reading, map bans)
  bracket.js           — Bracket building and advancement logic
  leaderboardExport.js — Leaderboard data storage and HTML/JSON generation
  leaderboardClient.js — Pushes results to a remote leaderboard VPS (optional)
  config.js            — All tuneable settings in one place

dashboard/public/
  dashboard.html       — Admin control panel (served at /dashboard)

leaderboard/
  index.html           — Public leaderboard page
  data.json            — Generated leaderboard data (auto-synced after each tournament)
  live.json            — Live bracket data (updated after every match result)

data/
  accounts.json        — Bot credentials (gitignored)
  leaderboard.json     — Persistent leaderboard records (mount as Docker volume)
  replays/             — Saved replay files
```

---

## Setup

### Prerequisites

- **Node.js 18+**
- A Chromium-based browser (Chrome or Edge) — or let Playwright download Chromium automatically
- At least **2 LittleWarGame accounts**: one controller (reads the lobby) and one or more worker bots (host matches)

### Install

```bash
git clone https://github.com/ometotchtli90/LWG-Tournamentbot.git
cd LWG-Tournamentbot
npm install
npx playwright install chromium        # only needed if Chrome/Edge aren't installed
npx playwright install-deps chromium   # Linux only — installs system libs
```

### Configure accounts

Create `data/accounts.json`:

```json
{
  "controller": { "username": "MyControllerBot", "password": "secret" },
  "workers": [
    { "username": "WorkerBot1", "password": "secret" },
    { "username": "WorkerBot2", "password": "secret" }
  ]
}
```

The **controller** account watches the public lobby chat for commands (`!join`, `!leave`, `!bracket`, etc.) and announces matches.  
Each **worker** account opens a separate browser, creates a game, and hosts exactly one match at a time.

### Start

```bash
npm start
```

The admin dashboard is available at **`http://localhost:3000/dashboard`**.

To run persistently on a server with [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start pm2.config.js
pm2 save && pm2 startup
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HEADLESS` | `true` | Run worker browsers headless (`false` to watch) |
| `CONTROLLER_HEADLESS` | same as `HEADLESS` | Run controller browser headless |

---

## Configuration (`src/config.js`)

| Key | Default | Description |
|---|---|---|
| `signupKeyword` | `!join` | Players type this to register |
| `signupDurationMs` | `300000` | How long signup stays open (ms) |
| `mapName` | `Ravaged` | Fallback map when no pool is configured |
| `gameNamePrefix` | `TOURNEY` | Prefix for game lobby names |
| `minPlayers` | `4` | Minimum players required to start |
| `maxPlayers` | `4` | Maximum players in instant-signup mode |
| `betweenMatchDelayMs` | `10000` | Pause between series games (ms) |
| `joinWaitMs` | `300000` | How long to wait for players to join (ms) |
| `readyWaitMs` | `300000` | How long to wait for `!ready` from both players (ms) |
| `banTimeoutMs` | `180000` | Time limit for the map ban phase (ms) |
| `intruderKickMs` | `10000` | Grace period before kicking an uninvited player (ms) |
| `bracketFormat` | `single_elimination` | Default format |
| `lwgUrl` | LWG play URL | Game URL for browser navigation |

### Per-format overrides (`formatSettings`)

```js
formatSettings: {
  single_elimination: {
    mapPool: ['Ravaged'],   // 1 map = no ban phase
    bestOf:  1,             // BO1
  },
  double_elimination: {
    mapPool: ['Ravaged', 'Silent Fjord LE', 'Burning Sands', 'Winter War', 'Deadlock'],
    bestOf:  3,             // BO3 — first to 2 wins
  },
},
```

When the map pool has more maps than games in the series, a map ban phase runs before game 1.

---

## Player Commands

Type these in **LittleWarGame lobby chat** (main lobby or game lobby).

| Command | Phase | Description |
|---|---|---|
| `!join` | Signup | Register for the currently open tournament |
| `!leave` | Signup | Unregister from signup |
| `!ready` | Game lobby | Confirm you are ready to start the match |
| `!forfeit` | Game lobby | Immediately forfeit — you lose the match |
| `!rehost` | Game lobby | Request a rehost; **both** players must type this to confirm |
| `!kick <player>` | Game lobby | Vote to kick a spectator; both tournament players must agree |
| `!spec` | Game lobby | Move the bot back to the spectator slot |
| `!bracket` | Anywhere | Bot replies with the leaderboard link |
| `!commands` | Game lobby | Bot replies with the full command list |

---

## Admin Dashboard

The dashboard at `/dashboard` provides:

| Control | Description |
|---|---|
| **Open Signup** | Start a signup phase; choose format and instant/timed mode |
| **Close Signup** | Close signup early and build the bracket |
| **Add / Remove Player** | Manually register or remove a player |
| **Force Win** | Advance a player without playing (e.g. opponent no-showed) |
| **Override Result** | Correct a finished match result (only when the next round hasn't started) |
| **Reconnect** | Re-login all browsers without losing tournament state |
| **Reset** | Cancel the current tournament and return to idle |
| **Event log** | Colour-coded terminal log of all bot activity in real time |

---

## Leaderboard

After every completed tournament `recordTournament()` writes:

1. `data/leaderboard.json` — persistent master record (mount this as a Docker volume)
2. `leaderboard/data.json` — web-served copy picked up by the public leaderboard page
3. `leaderboard/live.json` — live bracket state, updated after every match result

### Points system

| Finish | Points |
|---|---|
| 🥇 1st | 10 |
| 🥈 2nd | 5 |
| 🥉 3rd | 2 |
| Participated | 1 |

The public leaderboard shows all-time standings, the latest bracket, and the full tournament history with per-match replay download links.

---

## Deployment (Linux VPS / Docker)

### PM2 (bare metal)

```bash
npm install -g pm2
pm2 start pm2.config.js
pm2 save && pm2 startup
```

### Docker

A minimal Dockerfile:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.59.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

Mount `/app/data` as a persistent volume so `leaderboard.json` and replays survive container restarts.

### Coolify

Switch the Build Pack to **Dockerfile** and set:
- `BOT_UPSTREAM` = `http://YOUR_BOT_VPS_IP:4321/` (proxy target)
- `DASHBOARD_HTPASSWD` = `admin:{SHA}yourHash=` (basic auth for `/Admin`)

The leaderboard Nginx config template (`leaderboard/nginx.conf.template`) substitutes `BOT_UPSTREAM` at container start via `docker-entrypoint-extra.sh`.

---

## Project Structure (file-by-file)

| File | Role |
|---|---|
| `src/server.js` | HTTP server, WebSocket broadcast, static file serving |
| `src/controller.js` | Signup, bracket building, match dispatch, result application |
| `src/worker.js` | `hostMatch` / `hostSeries` — full automation of a single match |
| `src/pageHelpers.js` | Playwright helpers: login, chat, lobby slot reading, map bans |
| `src/bracket.js` | Pure bracket logic: build, advance, check complete |
| `src/leaderboardExport.js` | Record results, generate HTML, write JSON files |
| `src/leaderboardClient.js` | Optional push to remote leaderboard VPS over HTTP |
| `src/config.js` | All tuneable constants |
| `dashboard/public/dashboard.html` | Single-page admin control panel |
| `leaderboard/index.html` | Public-facing leaderboard SPA |

---

## License

MIT
