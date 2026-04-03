FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm ci --omit=dev

COPY src/         ./src/
COPY dashboard/   ./dashboard/
COPY leaderboard/ ./leaderboard/

# data/ and logs/ are runtime-only — not baked into the image.
# Mount a persistent volume in Coolify to /app/data so that
# accounts.json and config-override.json survive redeploys.
RUN mkdir -p /app/data /app/logs

EXPOSE 4321
CMD ["node", "src/server.js"]
