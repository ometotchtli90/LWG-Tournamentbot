#!/bin/bash
# Note: no set -e — VNC/display services are optional;
# Node.js must always start even if they fail.

# ── Virtual display ──────────────────────────────────────────
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99

# Give Xvfb time to initialize before dependent services start
sleep 2

# ── Window manager ───────────────────────────────────────────
fluxbox &>/dev/null &

# ── VNC server (localhost only — noVNC proxies it) ───────────
VNC_PASS="${VNC_PASSWORD:-changeme}"
x11vnc -display :99 \
       -passwd "$VNC_PASS" \
       -listen 127.0.0.1 \
       -rfbport 5900 \
       -forever -shared -quiet &>/dev/null &

# ── noVNC web client (WebSocket → VNC proxy) ─────────────────
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &>/dev/null &

# ── Node.js bot server (main process) ────────────────────────
exec node /app/src/server.js
