#!/bin/sh
set -e

USER="${ADMIN_USER:-admin}"
PASS="${ADMIN_PASSWORD}"

if [ -z "$PASS" ]; then
  echo "[htpasswd] WARNING: ADMIN_PASSWORD not set — /Admin will return 403."
  exit 0
fi

echo "${USER}:{PLAIN}${PASS}" > /usr/share/nginx/html/leaderboard/.htpasswd
echo "[htpasswd] Written for user '${USER}'."
