# LWG Tournament Bot

Automated tournament bot for [LittleWarGame.com](https://www.littlewargame.com/play/).

## Structure

```
├── bot/               — Electron desktop app (run locally)
│   ├── src/           — Bot source code
│   ├── dashboard/     — Local control panel UI
│   └── package.json
│
├── leaderboard/       — Public leaderboard website
│   ├── index.html     — Static site (never changes)
│   ├── data.json      — Tournament data (edit & push to update)
│   ├── webhook.js     — Server-side auto-deploy receiver
│   └── DATA_FORMAT.md — How to edit data.json
│
└── .github/workflows/
    └── release.yml    — Auto-builds .exe on git tag push
```

## Bot — Local Setup

```bash
cd bot
npm install
npx playwright install chromium
npm start
```

Open `http://localhost:3000` — the dashboard loads automatically in Electron.

## Leaderboard — Online

The `leaderboard/` folder is a static website. Host it anywhere:

- **GitHub Pages:** Settings → Pages → Source: `main` → `/leaderboard`  
  *(or copy contents to repo root for simpler setup)*
- **Own server:** Copy files, point nginx/apache at the folder, run `webhook.js` for auto-deploy

Update results by editing `leaderboard/data.json` and pushing.  
See `leaderboard/DATA_FORMAT.md` for the full data format.

## Release Build (.exe)

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions builds the Windows installer automatically and creates a Release.

## Webhook Auto-Deploy (own server)

```bash
cd leaderboard
export WEBHOOK_SECRET="your-secret"
export REPO_DIR="/path/to/cloned/repo/leaderboard"
node webhook.js   # or: pm2 start webhook.js --name lwg-webhook
```

Configure in GitHub: Repo → Settings → Webhooks → `http://yourserver/webhook`
