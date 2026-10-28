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
# /opt/quote-mcp/map holds the concept map's build (human-work-map's deploy writes it), outside
# releases/ so a quote-mcp deploy never removes it; world-readable so the quote user can serve it.
install -d -m 0755 /opt/quote-mcp /opt/quote-mcp/releases /opt/quote-mcp/map /etc/quote-mcp
if [ ! -f /etc/quote-mcp/env ]; then
  install -m 0640 -g quote /dev/null /etc/quote-mcp/env
  cat > /etc/quote-mcp/env <<'ENV'
QUOTE_DB=/var/lib/quote-mcp/quotes.db
QUOTE_HOST=0.0.0.0
QUOTE_PORT=8000
QUOTE_DICTIONARY=/usr/share/dict/words
ENV
fi
# Added after the first provision, so set it in an existing env too.
grep -q '^QUOTE_MAP_DIR=' /etc/quote-mcp/env || echo 'QUOTE_MAP_DIR=/opt/quote-mcp/map' >> /etc/quote-mcp/env

echo "node=$(node --version)"
echo "provisioned=$(hostname)"
