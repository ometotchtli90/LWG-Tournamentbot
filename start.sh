#!/bin/bash
set -e

# ── Virtual display (needed for headed controller browser) ──
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99

# Minimal window manager so browser windows render properly
fluxbox &

# ── VNC server (localhost only — noVNC proxies it) ──────────
VNC_PASS="${VNC_PASSWORD:-changeme}"
x11vnc -display :99 \
       -passwd "$VNC_PASS" \
       -listen 127.0.0.1 \
       -rfbport 5900 \
       -forever -shared -quiet &

# ── noVNC web client (WebSocket → VNC proxy) ────────────────
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &

# ── Node.js bot server ───────────────────────────────────────
exec node /app/src/server.js
