# 🏆 LWG Tournament Bot

> Fully automated single-elimination tournament manager for [LittleWarGame.com](https://www.littlewargame.com/play/)

Runs 5 browser accounts simultaneously via [Playwright](https://playwright.dev/) — one controller and four worker bots. Manages signups, builds brackets, hosts games, monitors matches, and updates results automatically. Controlled through a local web dashboard.

---

## ✨ Features

- **Automated signup** — players type `!join` in lobby chat to register
- **Single-elimination bracket** — randomly seeded, BYE slots handled automatically
- **Fully automated match hosting** — worker bots create the game, select the map, spectate, kick intruders, start the game, and detect the winner
- **Winner detection** — watches for GG in chat and/or player disconnect
- **Live web dashboard** — real-time bracket, worker status, event log, and manual controls
- **Cross-platform** — works on Windows, macOS, and Linux

---

## 📸 How It Looks

```
⚔️  SEMI-FINALS — 2 matches. Check your PMs!

PM → PlayerA:  ⚔️ Your match: PlayerA vs PlayerB | Hosted by: TourneyBot1
PM → PlayerB:  ⚔️ Your match: PlayerA vs PlayerB | Hosted by: TourneyBot1

[TourneyBot1 creates game, spectates, waits for players, starts match...]

🏆 PlayerA wins! PlayerB conceded.
```

---

## 🗂️ Project Structure

```
tourney/
├── src/
│   ├── index.js          # Entry point
│   ├── controller.js     # Tournament state machine + chat watcher
│   ├── worker.js         # Per-match host logic
│   ├── pageHelpers.js    # Playwright wrappers for all LWG interactions
│   ├── bracket.js        # Bracket building & propagation
│   ├── server.js         # Express + WebSocket dashboard server
│   └── config.js         # All configurable settings
├── dashboard/
│   └── public/
│       └── index.html    # Web dashboard (single-file)
├── accounts.json         # ← Your credentials go here (gitignored)
├── package.json
└── README.md
```

---

## 🚀 Setup

### Prerequisites

**Node.js v18+** — [nodejs.org](https://nodejs.org/)

| Platform | Install |
|----------|---------|
| Windows  | Download installer from nodejs.org |
| macOS    | `brew install node` or download installer |
| Linux    | `sudo apt install nodejs npm` |

---

### 1. Clone & install

```bash
git clone https://github.com/yourname/lwg-tournament-bot.git
cd lwg-tournament-bot
npm install
```

### 2. Install Chromium

Playwright needs its own Chromium binary (~150 MB, one-time download):

```bash
npm run install-browsers
```

### 3. Configure accounts

Edit `accounts.json` with your credentials:

```json
{
  "controller": {
    "username": "TourneyMaster",
    "password": "your_password"
  },
  "workers": [
    { "username": "TourneyBot1", "password": "your_password" },
    { "username": "TourneyBot2", "password": "your_password" },
    { "username": "TourneyBot3", "password": "your_password" },
    { "username": "TourneyBot4", "password": "your_password" }
  ]
}
```

> ⚠️ `accounts.json` is in `.gitignore` and will never be committed.

### 4. (Optional) Tweak settings

Edit `src/config.js` to change map, timers, keywords, etc.:

```js
mapName:             "Ravaged",
signupDurationMs:    120_000,   // 2 minutes
joinWaitMs:          900_000,   // 15 minutes for players to join
gamePassword:        "tourney2025",
```

---

## ▶️ Running

```bash
npm start
```

This will:
1. Launch 5 Chromium windows and log into each account automatically
2. Start the dashboard at **http://localhost:3000**
3. Begin watching lobby chat for commands

Open **http://localhost:3000** to control the tournament.

Press `Ctrl+C` to stop — all browser windows close automatically.

---

## 🖥️ Dashboard

The dashboard updates in real time over WebSocket.

| Section | Description |
|---------|-------------|
| **Controls** | Open/close signup, reset, print bracket & standings to chat |
| **Workers** | 🟢 free · 🟡 currently hosting a match |
| **Players** | Registered players list, add/remove manually |
| **Bracket** | Live bracket — gold border = active match, green = won, red = eliminated |
| **Active Matches** | Currently running games with assigned worker |
| **Event Log** | Real-time stream of everything: joins, results, errors |
| **Force Win** | Manually advance a player if a match gets stuck |

---

## 💬 Player Chat Commands

Players type these in the LWG **lobby chat**:

| Command | Effect |
|---------|--------|
| `!join` | Register for the tournament during signup |
| `!bracket` | Print the current bracket to chat |
| `!standings` | Show who's still in / eliminated |
| `!win PlayerName` | Manually report a match result |

---

## ⚙️ How a Match Works

```
1. Round announced in lobby chat
   "⚔️ SEMI-FINALS — 2 matches. Check your PMs!"

2. Each player receives an individual PM
   "⚔️ Your match: Alice vs Bob | Hosted by: TourneyBot2"

3. Worker bot (TourneyBot1–4):
   ├─ Clicks Create Game
   ├─ Searches for and selects the Ravaged map
   ├─ Sets game name and password
   ├─ Waits for the Spectate button, then clicks it
   ├─ Polls player slots every 500ms
   │   └─ Kicks any intruder silently after 10s
   ├─ Waits for both players to join (up to 15 min)
   ├─ Asks players to type !ready
   ├─ Counts up: 1… 2… 3… 4… 5… FIGHT!
   ├─ Clicks Start
   ├─ Watches in-game chat for "gg" (first 2 min)
   └─ Watches for "Player X left" server messages

4. Result detected → bracket auto-updates
   "🏆 Alice wins! Bob conceded."
   PM → Alice: "You advance!"
   PM → Bob:   "You've been eliminated."

5. Next round starts automatically when all matches are done
```

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---------|----------|
| `accounts.json not found` | Make sure the file exists in the project root and is valid JSON |
| Login fails | Check username/password — LWG usernames are case-sensitive |
| Map button not found | Verify `mapName` in `src/config.js` matches the exact button text on LWG |
| Spectate button timeout | Raise the timeout in `src/config.js` → `joinWaitMs` |
| Match stuck / no result | Use **Force Win** in the dashboard or type `!win PlayerName` in chat |
| Worker shows busy but game ended | Click **Reset** on the dashboard and use Force Win to catch up the bracket |

---

## 📄 License

MIT — do whatever you want with it.
