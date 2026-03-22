# LWG Tournament Bot

An automated tournament manager for [LittleWarGame.com](https://www.littlewargame.com/play/).  
Runs as a desktop app (Electron) and controls multiple LWG accounts to host, referee, and advance bracket tournaments — hands-free.

---

## What it does

- Players sign up in lobby chat by typing `!join`
- Bot builds a bracket (Single or Double Elimination) and announces all matches
- Worker bot accounts each host a game, kick intruders, wait for players, count down, and start the game
- Winner is detected when the losing player types `gg` in game chat
- Bracket advances automatically — next round starts when workers become free
- Full bracket view in the live dashboard UI

---

## Requirements

- **Windows 10/11** (macOS/Linux builds are in package.json but untested)
- **Google Chrome** installed — the bot launches and controls it
- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Multiple LWG accounts** — one controller + one worker per concurrent match

### How many worker accounts do you need?

Each first-round match needs one worker account. Workers free up as rounds progress.

| Max Players | Workers Needed |
|-------------|---------------|
| 4           | 2             |
| 8           | 4             |
| 16          | 8             |
| 32          | 16            |

---

## Installation

### Option A — Installer (recommended)

1. Download `LWG Tournament Bot Setup x.x.x.exe` from the [Releases](../../releases) page
2. Run the installer and choose your install directory
3. Launch **LWG Tournament Bot** from Start Menu or desktop shortcut

> **Windows SmartScreen warning**: Because the installer is unsigned, Windows will show "Windows protected your PC". Click **More info → Run anyway**. This is expected — the app only contacts LWG servers.

### Option B — From source

```bash
git clone https://github.com/YOUR_USERNAME/LWG-Tournamentbot.git
cd LWG-Tournamentbot
npm install
npm start
```

---

## First-time setup

1. Open the app and click **⚙ Settings**
2. Enter your **Controller Account** credentials (e.g. `TourneyMaster`) — this account stays in the lobby and sends announcements
3. Add **Worker Accounts** — click **+ Add Worker** for each one. The dashboard shows how many you need based on Max Players and turns red if you don't have enough
4. Configure **Tournament Settings**:
   - **Bracket Format**: Single Elimination or Double Elimination
   - **Signup Duration**: how long players can type `!join` (default: 5 min)
   - **Min / Max Players**: bracket size (default: 4)
   - **Join Wait**: time workers wait for players before declaring a no-show (default: 5 min)
5. Click **Save Settings**

---

## Running a tournament

1. **Launch Browsers** — Chrome opens. Controller window is visible; worker windows are hidden. First launch takes ~30s while LWG popups are dismissed and accounts log in.

2. **Open Signup** — TourneyMaster announces signup in lobby chat. Players type `!join` to enter, `!leave` to withdraw. Signup closes automatically when full, or after the timer expires.

3. **Bracket builds automatically** — TourneyMaster announces each match and which worker will host it.

4. **Matches run** — Worker bots create games one after another (each waits until the previous is in the spectator slot before starting), then all games run in parallel:
   - Worker announces in lobby chat: *"I will host for Alice vs Bob — waiting 5 minutes for you to join!"*
   - Players join the game and type `!ready`
   - Worker counts down `5… 4… 3… 2… 1… FIGHT!`
   - At game start, worker sends: *"When you lose, please type gg before leaving!"*

5. **Result detection** — When the loser types `gg` in game chat, the bot waits 5 seconds, leaves the game, closes the stats screen, and reports the result. Bracket advances. Next round starts when workers are free.

### Player commands (in lobby chat)

| Command | Effect |
|---------|--------|
| `!join` | Register for signup |
| `!leave` | Unregister during signup |
| `!bracket` | Print bracket to chat |
| `!standings` | Print alive / eliminated list |
| `!win PlayerName` | Manually report a result (organiser only) |

---

## Dashboard reference

| Control | Available | Effect |
|---------|-----------|--------|
| 🚀 Launch Browsers | Before boot | Opens Chrome, logs in all accounts |
| ▶ Open Signup | After boot, idle | Starts signup phase |
| ⏹ Close Signup Early | During signup | Ends signup and builds bracket now |
| ✕ Cancel Tournament | Any time | Resets to idle |
| Add / Remove Player | During signup | Manually manage the player list |
| Force Win | During tournament | Manually advance a player (for stuck games) |
| Bracket / Standings | During tournament | Print to lobby chat |

---

## Building the installer

Run these commands in Command Prompt or PowerShell on Windows:

```bat
cd C:\path\to\LWG-Tournamentbot
npm install
set CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist:win
```

Output: `dist\LWG Tournament Bot Setup 1.0.0.exe`

The `CSC_IDENTITY_AUTO_DISCOVERY=false` flag skips code signing. Without a paid code-signing certificate, this is required — otherwise the build fails.

---

## Publishing a release on GitHub

1. Build the installer (see above)
2. Bump the version in `package.json` (e.g. `"version": "1.1.0"`)
3. Commit and push:
   ```bash
   git add .
   git commit -m "v1.1.0"
   git push origin main
   ```
4. On GitHub: **Releases → Draft a new release**
   - Tag: `v1.1.0`
   - Title: `LWG Tournament Bot v1.1.0`
   - Upload: `dist/LWG Tournament Bot Setup 1.1.0.exe`
   - Write release notes describing what changed
5. Publish release

---

## ⚠️ Things to be aware of

### Accounts must be real registered LWG accounts
Guest accounts are not reliable. Create dedicated accounts like `TourneyBot1`, `TourneyBot2` specifically for this bot.

### The `gg` requirement
The bot detects the end of a game by the losing player typing **`gg`** in in-game chat. If no one types it, the game hangs. The bot sends a reminder at the start of every game. If a game gets stuck, use **Force Win** in the dashboard.

### First launch popups
On first load, LWG shows a changelog and a Patreon popup. The bot dismisses both automatically. If it times out, just restart — after the first visit the popups won't appear again.

### Workers run headless
Worker browser windows are invisible by default. To see them for debugging:
```bat
set HEADLESS=false
npm start
```

### No game password
The bot doesn't set a password on hosted games — it kicks any player who joins who isn't supposed to be there. Keep tournament signup short to minimise the window for gate-crashers.

### No-show handling
- **One player no-show**: the player who joined wins by default. No-show is disqualified.
- **Both no-show**: both are disqualified. Use **Force Win** to move the bracket forward.

### Worker count must match max players
The dashboard shows a warning and disables Launch if you don't have enough worker accounts for your Max Players setting. Fix in Settings before launching.

### Don't use TourneyMaster for anything else
The controller account needs to stay in the LWG lobby for the duration of the tournament. Using it in a game or logging it out will break detection and chat commands.

### Double Elimination note
Double elimination requires more workers (losers drop to a separate bracket that runs alongside the winner bracket). Make sure your worker count covers the maximum number of simultaneous matches across both brackets.

---

## File structure

```
src/
  main.js          — Electron entry, Express/WebSocket server
  controller.js    — Tournament state machine
  worker.js        — Per-match host logic
  pageHelpers.js   — Playwright helpers for LWG interactions
  bracket.js       — Single/Double elimination bracket engine
  config.js        — Default settings
  server.js        — Standalone (non-Electron) server entry
dashboard/
  public/
    index.html     — Dashboard UI (single self-contained file)
```

---

## License

MIT
