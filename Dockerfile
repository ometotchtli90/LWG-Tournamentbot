FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV TZ=UTC DEBIAN_FRONTEND=noninteractive

# Install virtual display + VNC + noVNC for headed controller browser
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src/         ./src/
COPY dashboard/   ./dashboard/
COPY leaderboard/ ./leaderboard/
COPY start.sh     /start.sh

RUN chmod +x /start.sh \
 && mkdir -p /app/data /app/logs

# 4321 = bot API/dashboard   6080 = noVNC web viewer
EXPOSE 4321 6080

CMD ["/start.sh"]
