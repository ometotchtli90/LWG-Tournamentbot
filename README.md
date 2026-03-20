# 🏆 LWG Tournament Bot

> Fully automated single-elimination tournament manager for [LittleWarGame.com](https://www.littlewargame.com/play/)

A desktop app (Windows / macOS / Linux) that controls 5 browser accounts simultaneously — one controller and four worker bots. Manages signups, builds brackets, hosts games, monitors matches, and updates results automatically. No terminal required.

---

## ✨ Features

- **One-click launch** — double-click the app, enter credentials in Settings, click Launch
- **Automated match hosting** — worker bots create the game, select the map, wait for players, start, detect the winner
- **Private messaging** — each player gets their match details via PM
- **Winner detection** — GG in chat + disconnect monitoring
- **Built-in Settings screen** — manage accounts and tournament config without editing any files
- **Live bracket & event log** — everything updates in real time
- **Cross-platform** — Windows `.exe`, macOS `.dmg`, Linux `.AppImage`

---

## 🚀 Running the App

### Option A — Download a release (recommended)

Download the installer for your platform from the [Releases](../../releases) page:

| Platform | File |
|----------|------|
| Windows  | `LWG.Tournament.Bot.Setup.x.x.x.exe` |
| macOS    | `LWG.Tournament.Bot-x.x.x.dmg` |
| Linux    | `LWG.Tournament.Bot-x.x.x.AppImage` |

Run the installer, open the app, go to **⚙ Settings**, fill in your account passwords, and click **Save**.

### Option B — Run from source

**Requirements:** [Node.js v18+](https://nodejs.org/)

```bash
git clone https://github.com/yourname/lwg-tournament-bot.git
cd lwg-tournament-bot
npm install
npm run install-browsers   # downloads Chromium (~150 MB, one-time)
npm start
```

---

## 🏗️ Building Installers

```bash
npm run install-browsers   # must run before building

npm run dist:win           # → dist/LWG Tournament Bot Setup x.x.x.exe
npm run dist:mac           # → dist/LWG Tournament Bot-x.x.x.dmg
npm run dist:linux         # → dist/LWG Tournament Bot-x.x.x.AppImage
npm run dist:all           # build all three at once
```

> ⚠️ Cross-compiling (e.g. building a `.dmg` on Windows) is not supported by electron-builder. Build each platform on its native OS, or use CI (GitHub Actions).

---

## ⚙️ Settings

Open the **⚙ Settings** tab in the app:

| Field | Description |
|-------|-------------|
| Controller Username / Password | Your `TourneyMaster` account |
| Worker 1–4 Username / Password | Your `TourneyBot1`–`TourneyBot4` accounts |
| Map Name | The LWG map to host on (default: `Ravaged`) |
| Game Password | Password set on each hosted game |
| Signup Duration | How long players have to type `!join` (seconds) |
| Min / Max Players | Tournament size limits |
| Join Wait | How long a worker waits for players to join a game (minutes) |

Credentials are saved to your OS app-data folder and never leave your machine.

---

## ▶️ Running a Tournament

1. Open the app → go to **⚙ Settings** → enter passwords → **Save**
2. Go to **Tournament** tab → click **🚀 Launch Browsers**
   - 5 Chromium windows open and log in automatically (~20 seconds)
3. Click **Open Signup** — players type `!join` in LWG lobby chat
4. Click **Close Signup Early** (or wait for the timer) — bracket builds automatically
5. Matches run automatically from here. Monitor via the bracket and event log.

---

## 💬 Player Chat Commands

| Command | Effect |
|---------|--------|
| `!join` | Register during signup |
| `!bracket` | Print bracket to chat |
| `!standings` | Show alive / eliminated |
| `!win PlayerName` | Manually report a result |

---

## ⚙️ How a Match Works

```
Round announced: "⚔️ SEMI-FINALS — check your PMs!"

PM → Player A: "⚔️ Your match: A vs B | Hosted by: TourneyBot2"
PM → Player B: "⚔️ Your match: A vs B | Hosted by: TourneyBot2"

TourneyBot2 (separate Chromium window):
  ├─ Creates game, selects Ravaged map
  ├─ Sets name + password, spectates
  ├─ Waits for A and B to join (kicks anyone else after 10s)
  ├─ "A vs B — type !ready to start"
  ├─ "✅ Both ready! 1… 2… 3… 4… 5… FIGHT!"
  ├─ Starts the game
  ├─ Watches for "gg" (first 2 min) or player disconnect
  └─ Reports result → bracket auto-updates

"🏆 A wins! B conceded."
```

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---------|-----|
| "Controller password not set" | Go to Settings and fill in all passwords |
| Login fails | Check username/password — LWG is case-sensitive |
| Map not found | Verify Map Name in Settings matches the exact LWG button text |
| Match stuck | Use **Force Win** in the dashboard |
| App won't open on macOS | Right-click the `.app` → Open (bypasses Gatekeeper on first run) |
| Linux AppImage won't run | `chmod +x LWG*.AppImage` then run it |

---

## 📄 License

MIT
