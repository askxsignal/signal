#!/usr/bin/env bash
# Build in the repo and ship the runtime files to /srv/signal, then restart the service.
# Usage (as root, from anywhere): /root/signal/deploy/deploy.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/srv/signal
SITE_URL="$(grep -E '^SITE_URL=' /etc/signal.env | cut -d= -f2-)"
cd "$REPO"
npm ci --no-audit --no-fund
VITE_BACKEND=api SITE_URL="$SITE_URL" npm run build
rsync -a --delete \
  --include='/dist/***' --include='/netlify/***' --include='/shared/***' --include='/node_modules/***' \
  --include='/server.mjs' --include='/package.json' --exclude='*' \
  "$REPO/" "$DEST/"
chown -R root:signal "$DEST"; chmod -R g+rX,o-rwx "$DEST"
systemctl restart signal
sleep 4
curl -fsS http://127.0.0.1:8787/api/health && echo
