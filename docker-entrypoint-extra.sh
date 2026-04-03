#!/bin/sh
set -e
if [ -n "$DASHBOARD_HTPASSWD" ]; then
  echo "$DASHBOARD_HTPASSWD" > /usr/share/nginx/html/leaderboard/.htpasswd
  echo "[htpasswd] Written from DASHBOARD_HTPASSWD env variable."
else
  echo "[htpasswd] WARNING: DASHBOARD_HTPASSWD not set — /Admin will return 500."
fi
