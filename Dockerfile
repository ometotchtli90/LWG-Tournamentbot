FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm ci --omit=dev

COPY src/        ./src/
COPY dashboard/  ./dashboard/
COPY leaderboard/ ./leaderboard/
COPY data/       ./data/

EXPOSE 4321
CMD ["node", "src/server.js"]
