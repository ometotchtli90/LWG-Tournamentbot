#!/bin/sh
set -e

# Generates .htpasswd from ADMIN_USER (default: admin) and ADMIN_PASSWORD env variables.
# No pre-hashing needed — just set ADMIN_PASSWORD=yourpassword in Coolify.

USER="${ADMIN_USER:-admin}"
PASS="${ADMIN_PASSWORD}"

if [ -z "$PASS" ]; then
  echo "[htpasswd] WARNING: ADMIN_PASSWORD not set — /Admin will return 401."
  exit 0
fi

# Generate SHA1 hash using openssl (always available in nginx:alpine)
HASH=$(printf '%s' "$PASS" | openssl dgst -sha1 -binary | openssl base64)
echo "${USER}:{SHA}${HASH}" > /usr/share/nginx/html/leaderboard/.htpasswd
echo "[htpasswd] Written for user '${USER}'."
