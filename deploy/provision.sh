#!/bin/bash
# One-time setup of the quote-mcp LXC. Runs as root (tools/deploy.mjs --provision).
# Idempotent: rerunning it changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
# better-sqlite3 13 ships no prebuilt binaries, so npm ci compiles it. wamerican is the OCR check's word list.
apt-get install -y -q curl build-essential python3 wamerican

id quote >/dev/null 2>&1 || useradd --system --home-dir /var/lib/quote-mcp --shell /usr/sbin/nologin quote
install -d -o quote -g quote -m 0750 /var/lib/quote-mcp /var/lib/quote-mcp/backups
# /opt/quote-mcp/map holds the concept maps' build (quote-atlas's deploy writes it), outside
# releases/ so a quote-mcp deploy never removes it; world-readable so the quote user can serve it.
install -d -m 0755 /opt/quote-mcp /opt/quote-mcp/releases /opt/quote-mcp/map /etc/quote-mcp
# The server's settings (/etc/quote-mcp/generated.env) are written by each deploy, from deploy/server.env and
# the deploying machine's .env; nothing is set here.

echo "node=$(node --version)"
echo "provisioned=$(hostname)"
