#!/usr/bin/env bash
# TRIBUTE safe deploy: repo/gateway -> live proxy (/root/tribute/proxy).
#
# Why this exists: the OSS repo (github.com/tributelab/tribute) and the
# live systemd service (tribute-proxy.service, running from
# /root/tribute/proxy) are TWO SEPARATE COPIES of the same gateway code —
# there is no shared filesystem link, no CI/CD. A fix landed in the repo
# does NOT reach production until someone runs this script. (This bit us
# once already: 2026-09-23 security/feature fixes sat in git for a full day
# before anyone noticed api-gw.tributex402.com was still running the old
# code.) Run this after every gateway change that's meant to go live.
#
# Safety: backs up live data/ + .env before touching anything, syntax-checks
# every file before copying, restarts, health-checks, and offers rollback
# instructions on failure. Never overwrites data/ or .env — those are
# runtime state and secrets, not part of the deploy.
set -u

REPO_GATEWAY=/root/tribute/repo/gateway
LIVE_DIR=/root/tribute/proxy
BACKUP_DIR="/root/tribute-proxy-backup-$(date -u +%Y%m%d-%H%M%S)"
SERVICE=tribute-proxy
HEALTH_URL="http://127.0.0.1:8792/x402/health"

# Files that make up the running gateway. data/ and .env are deliberately
# excluded — those are live state/secrets, never sourced from the repo.
FILES=(server.js facilitator.js agent-vault.js x402-routes.js balance.js
       ratelimit.js db.js x402-v2.js sessions.js reputation.js wallets.js
       keys.js marketplace.js data-providers.js article-extract.js)

echo "== TRIBUTE deploy: repo -> live =="

# 1. Pre-flight: repo gateway must pass its own test suite before it ships.
echo "-- running gateway test suite in repo --"
if ! (cd "$REPO_GATEWAY" && npm test); then
  echo "ABORT: repo gateway test suite failed — not deploying a broken build."
  exit 1
fi

# 2. Syntax-check every file about to be copied.
echo "-- syntax-checking files --"
for f in "${FILES[@]}"; do
  if [ ! -f "$REPO_GATEWAY/$f" ]; then
    echo "ABORT: $REPO_GATEWAY/$f does not exist — check FILES list."
    exit 1
  fi
  if ! node --check "$REPO_GATEWAY/$f"; then
    echo "ABORT: syntax error in $f — not deploying."
    exit 1
  fi
done
echo "   all files OK"

# 3. Backup live state before touching anything.
echo "-- backing up live state to $BACKUP_DIR --"
mkdir -p "$BACKUP_DIR"
cp -a "$LIVE_DIR"/*.js "$BACKUP_DIR/" 2>/dev/null
cp -a "$LIVE_DIR/data" "$BACKUP_DIR/data" 2>/dev/null
cp -a "$LIVE_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null
if [ ! -d "$BACKUP_DIR/data" ]; then
  echo "ABORT: backup of data/ failed — refusing to deploy without a safety net."
  exit 1
fi
echo "   backup OK ($(du -sh "$BACKUP_DIR" | cut -f1))"

# 4. Copy the code files (never data/, never .env).
echo "-- copying files to $LIVE_DIR --"
for f in "${FILES[@]}"; do
  cp "$REPO_GATEWAY/$f" "$LIVE_DIR/$f"
done

# 5. Restart and health-check.
echo "-- restarting $SERVICE --"
systemctl restart "$SERVICE"
sleep 3

if ! systemctl is-active --quiet "$SERVICE"; then
  echo "DEPLOY FAILED: $SERVICE did not come up. Rolling back."
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$f" "$LIVE_DIR/$f" 2>/dev/null; done
  systemctl restart "$SERVICE"
  echo "Rolled back to pre-deploy code. Investigate: journalctl -u $SERVICE -n 50"
  exit 1
fi

sleep 1
HEALTH=$(curl -s --max-time 10 "$HEALTH_URL")
HEALTH_OK=$(echo "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(j.ok?"1":"0")}catch{process.stdout.write("0")}})' 2>/dev/null)

if [ "$HEALTH_OK" != "1" ]; then
  echo "DEPLOY FAILED: health check did not report ok. Rolling back."
  echo "   health response: $HEALTH"
  for f in "${FILES[@]}"; do cp "$BACKUP_DIR/$f" "$LIVE_DIR/$f" 2>/dev/null; done
  systemctl restart "$SERVICE"
  echo "Rolled back to pre-deploy code. Investigate: journalctl -u $SERVICE -n 50"
  exit 1
fi

echo "== DEPLOY OK =="
echo "   service: active, health: ok"
echo "   backup kept at: $BACKUP_DIR (manual rollback: copy its *.js back + systemctl restart $SERVICE)"

# Record what SHA is now live, so the CD watcher (auto-deploy-watch.sh) knows
# not to redeploy the same commit every tick.
DEPLOYED_SHA=$(cd "$REPO_GATEWAY" && git rev-parse HEAD 2>/dev/null || echo unknown)
mkdir -p /root/backups/tribute
echo "$DEPLOYED_SHA" > /root/backups/tribute/.deployed_sha
echo "   deployed sha: $DEPLOYED_SHA"
exit 0
