# LWG Tournament Bot

Automated tournament bot for [LittleWarGame.com](https://www.littlewargame.com/play/).

## Repo structure

```
├── Dockerfile                   ← Coolify leaderboard deployment
├── docker-entrypoint-extra.sh   ← writes .htpasswd from ENV at container start
├── pm2.config.js                ← runs bot headlessly on VPS via PM2
├── package.json
├── src/                         ← Bot source (9 files)
├── dashboard/public/            ← Control panel UI
├── leaderboard/
│   ├── index.html               ← Public leaderboard (static)
│   ├── data.json                ← Tournament data (edit & push)
│   ├── nginx.conf.template      ← nginx config (BOT_UPSTREAM substituted from ENV)
│   ├── webhook.js               ← auto-deploy receiver
│   └── DATA_FORMAT.md
├── data/                        ← Runtime data (gitignored: accounts, config)
└── logs/                        ← PM2 logs (gitignored)
```

## Bot VPS setup (headless, Linux)

```bash
git clone https://github.com/ometotchtli90/LWG-Tournamentbot.git
cd LWG-Tournamentbot
npm install
npx playwright install chromium
npx playwright install-deps chromium
npm install -g pm2
mkdir -p data logs
pm2 start pm2.config.js
pm2 save && pm2 startup
```

Control via dashboard at https://lwgtourleaderboard.duckdns.org/Admin

## Leaderboard (Coolify)

Switch Build Pack to **Dockerfile**. Set ENV variables:
- `BOT_UPSTREAM` = `http://YOUR_BOT_VPS_IP:4321/`
- `DASHBOARD_HTPASSWD` = `admin:{SHA}yourHash=`

## Update leaderboard data

Edit `leaderboard/data.json`, commit and push.

## Windows .exe build

```bash
git tag v1.0.0 && git push origin v1.0.0
```
