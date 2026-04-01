# LWG Tournament Bot

Automated tournament bot for [LittleWarGame.com](https://www.littlewargame.com/play/).

## Structure

```
├── src/                    — Bot source code (Electron app)
├── dashboard/public/       — Local control panel (dashboard.html)
├── leaderboard/            — Public leaderboard website
│   ├── index.html          — Static site (never edit)
│   ├── data.json           — Tournament data (edit & push to update)
│   ├── .htpasswd           — Dashboard Basic Auth password
│   ├── webhook.js          — Auto-deploy receiver for your server
│   └── DATA_FORMAT.md      — How to edit data.json
├── .github/workflows/
│   └── release.yml         — Builds .exe on git tag push
└── package.json
```

## Run locally

```bash
npm install
npx playwright install chromium
npm start
```

## Release build

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Update leaderboard

Edit `leaderboard/data.json`, commit and push.
See `leaderboard/DATA_FORMAT.md` for the data format.

## Dashboard password

Generate a new hash and replace the line in `leaderboard/.htpasswd`:
```bash
python3 -c "import hashlib,base64; p=input('Pass: '); print('{SHA}'+base64.b64encode(hashlib.sha1(p.encode()).digest()).decode())"
```
