#!/usr/bin/env node
// Deploys quote-mcp to its LXC (quote-mcp.localdomain), on corpus-mcp's pattern: SSH as the shared
// `authoring` login, one `sudo -S` call per step with the password piped on stdin, a release
// directory per deploy, a health check, and rollback to the previous release on failure.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = process.env.QUOTE_DEPLOY_HOST ?? "authoring@quote-mcp.localdomain";
const ASKPASS = path.join(root, "tools", "askpass.mjs");

const USAGE = `Usage: npm run deploy -- [--provision | --env | --import-drupal] [--skip-tests]

  (no flag)        build, test, install this checkout as a new release, restart, health-check, roll
                   back on failure, and record the branch and commit in /var/lib/quote-mcp/deployed.json
                   (the server's /health reports it); the first deploy also runs the first import,
                   the old site included
  --provision      one-time setup of the LXC (Node 22, build tools, word list, quote user, directories)
  --env            copy the server's settings from .env into its /etc/quote-mcp/env (mode 0640) and
                   restart: QUOTE_ZOTERO_LIBRARY, QUOTE_ZOTERO_API_KEY, QUOTE_ZOTERO_SOURCES,
                   QUOTE_DRUPAL_URL, QUOTE_D1_PROXY_URL, and QUOTE_D1_PROXY_TOKEN. Only those set
                   in .env are replaced; the server's others are left as they are
  --import-drupal  run an import on the server with the old site included (the timer leaves it out)
  --skip-tests     deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD in .env.`;

const password = process.env.AUTHORING_DEPLOY_PASSWORD;
const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

function sshEnv() {
  return { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "quote-deploy" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Runs a bash script as root on the host; resolves with its stdout (also echoed). */
function runAsRoot(script) {
  const encoded = Buffer.from(script).toString("base64");
  const command = `sudo -S -p '' bash -c "$(printf %s '${encoded}' | base64 -d)"`;
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, HOST, command], { env: sshEnv(), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(`${password}\n`);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${HOST}: remote script exited with ${code}`))));
  });
}

/** Runs the CLI on the server as the quote user, with the server's environment. */
const asQuote = (args) => `runuser -u quote -- bash -c 'set -a; . /etc/quote-mcp/env; set +a; cd /opt/quote-mcp/current && node dist/cli.js ${args}'`;

async function provision() {
  await runAsRoot(fs.readFileSync(path.join(root, "deploy", "provision.sh"), "utf8"));
  console.log("\nProvisioned. Next: npm run deploy -- --env, then npm run deploy");
}

/**
 * Sets the server's settings from this machine's .env, so keys never pass through a chat or a command
 * line: the Zotero and old-site settings, and the D1 proxy the public replica ships through. Only the
 * ones set in .env are replaced, so one left out (or left empty, as a second, empty line in .env makes
 * it) never deletes the server's.
 */
async function pushEnv() {
  const all = ["QUOTE_ZOTERO_LIBRARY", "QUOTE_ZOTERO_API_KEY", "QUOTE_ZOTERO_SOURCES", "QUOTE_DRUPAL_URL", "QUOTE_D1_PROXY_URL", "QUOTE_D1_PROXY_TOKEN"];
  const library = process.env.QUOTE_ZOTERO_LIBRARY ?? "";
  if (library && !/^(users|groups)\/\d+$/.test(library)) throw new Error(`QUOTE_ZOTERO_LIBRARY should be "users/<user id>" or "groups/<group id>", not "${library}".`);
  const names = all.filter((n) => process.env[n]?.trim());
  if (!names.length) throw new Error(`None of ${all.join(", ")} is set in .env.`);
  console.log(`Setting ${names.join(", ")} on the server; leaving ${all.filter((n) => !names.includes(n)).join(", ") || "nothing else"} as it is.`);
  const lines = names.map((n) => `${n}=${process.env[n].trim()}`).join("\n");
  const encoded = Buffer.from(`${lines}\n`).toString("base64");
  await runAsRoot(`
set -euo pipefail
f=/etc/quote-mcp/env
grep -v ${names.map((n) => `-e '^${n}='`).join(" ")} "$f" > "$f.new" || true
printf %s ${shellQuote(encoded)} | base64 -d >> "$f.new"
chown root:quote "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
cut -d= -f1 "$f" | tr '\\n' ' '; echo
systemctl is-active --quiet quote-mcp.service || exit 0
# Wait for the server to answer, as a deploy does, so the push ends only once it's back (and the status
# items, which refresh when it ends, don't catch it mid-restart).
systemctl restart quote-mcp.service
set -a; . "$f"; set +a
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$QUOTE_PORT/health"; then echo "quote-mcp is back up."; exit 0; fi
  sleep 1
done
journalctl -u quote-mcp.service -n 20 --no-pager || true
echo "quote-mcp didn't answer /health within 20 seconds of the restart." >&2
exit 1`);
}

async function importDrupal() {
  await runAsRoot(`set -euo pipefail\n${asQuote("import")}`);
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `quote-mcp-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "vocab", "worker/wrangler.jsonc", "package.json", "package-lock.json"]);
  execFileSync("scp", [...sshOptions, tarball, `${HOST}:/tmp/`], { env: sshEnv(), stdio: "inherit" });
  fs.rmSync(tarball);

  await runAsRoot(`
set -euo pipefail
release=/opt/quote-mcp/releases/${id}
mkdir -p "$release"
tar xzf /tmp/quote-mcp-${id}.tgz -C "$release"
rm -f /tmp/quote-mcp-${id}.tgz
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
set -a; . /etc/quote-mcp/env; set +a
previous=$(readlink /opt/quote-mcp/current || true)
echo "previous=$previous"
# A first import that fails leaves this marker (and whatever store it made), so the next deploy runs it again.
first_import=/var/lib/quote-mcp/first-import.pending
# The store as it was before this release's migration changed its schema; a rollback puts it back, since the
# previous release refuses a store at a newer schema.
pre_migrate=/var/lib/quote-mcp/pre-migrate.db
rm -f "$pre_migrate"
install_units() {
  # Chained, since a rollback calls it in a condition, where set -e doesn't apply.
  install -m 0644 "$1/deploy/quote-mcp.service" "$1/deploy/quote-import.service" "$1/deploy/quote-import.timer" \\
    "$1/deploy/quote-backup.service" "$1/deploy/quote-backup.timer" /etc/systemd/system/ &&
    install -m 0755 "$1/deploy/quote-mcp" /usr/local/bin/quote-mcp &&
    systemctl daemon-reload
}
# From the switch on, any failure puts the previous release (and its units) back, and the store as it was
# before a migration that changed its schema. Otherwise the store is left as it is, even after a failed
# first import: it's primary data, and the next deploy or the import timer carries on from it.
rollback() {
  status=$?
  [ "$status" -eq 0 ] && return
  journalctl -u quote-mcp.service -n 20 --no-pager || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/quote-mcp/current
    units=1
    install_units "$previous" || units=""
    store=1
    if [ -f "$pre_migrate" ]; then
      systemctl stop quote-mcp.service quote-import.service || true
      # The copy is owned by quote before anything moves, so a failed chown leaves both stores where they
      # were. The moves are chained, so the copy never replaces a migrated store that couldn't be set aside,
      # and nothing more moves after a failure. The -wal and -shm go with the migrated store, renamed alike,
      # since committed writes can still be only in the -wal.
      if chown quote:quote "$pre_migrate" &&
        mv "$QUOTE_DB" "$QUOTE_DB.rolled-back" &&
        { [ ! -f "$QUOTE_DB-wal" ] || mv "$QUOTE_DB-wal" "$QUOTE_DB.rolled-back-wal"; } &&
        { [ ! -f "$QUOTE_DB-shm" ] || mv "$QUOTE_DB-shm" "$QUOTE_DB.rolled-back-shm"; } &&
        mv "$pre_migrate" "$QUOTE_DB"; then
        echo "restored the store from before the migration; the migrated one, with anything written since the migration, is $QUOTE_DB.rolled-back"
      else
        store=""
        # Nothing may open or create a store until a person has put the right one back: an import on a
        # missing store would start a new one.
        systemctl stop quote-import.timer quote-mcp.service quote-import.service || true
        echo "store_restore_failed: quote-mcp and the import timer are stopped. Where the stores are now:"
        for f in "$QUOTE_DB" "$QUOTE_DB-wal" "$QUOTE_DB.rolled-back" "$QUOTE_DB.rolled-back-wal" "$QUOTE_DB.rolled-back-shm" "$pre_migrate"; do
          [ -e "$f" ] && echo "  $f"
        done
        echo "  ($pre_migrate is the store from before the migration; the migrated one has anything written since)"
      fi
    fi
    if [ -n "$units" ] && [ -n "$store" ]; then
      systemctl restart quote-mcp.service || echo "quote-mcp didn't restart on $previous"
      echo "rolled_back=$previous"
    elif [ -z "$store" ]; then
      echo "rollback_incomplete=$previous: the store couldn't be put back, so quote-mcp wasn't restarted"
    else
      echo "rollback_incomplete=$previous: its units couldn't all be put back"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
ln -sfn "$release" /opt/quote-mcp/current.new && mv -T /opt/quote-mcp/current.new /opt/quote-mcp/current
install_units "$release"
if [ ! -f "$QUOTE_DB" ] || [ -f "$first_import" ]; then
  echo "No store yet: running the first import, the old site included."
  touch "$first_import"
  ${asQuote("import")}
  rm -f "$first_import"
else
  ${asQuote("migrate --backup /var/lib/quote-mcp/pre-migrate.db")}
fi
# The public site's preview reads a snapshot that imports rebuild; build it now so a new build's pages show at once
# (nothing, when vocab/site.md doesn't make the site public).
${asQuote("publish --dry-run --if-public")}
systemctl enable --quiet quote-mcp.service quote-import.timer quote-backup.timer
systemctl start quote-import.timer quote-backup.timer
systemctl restart quote-mcp.service
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$QUOTE_PORT/health"; then echo; echo "installed=${id}"; break; fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$QUOTE_PORT/health"
trap - EXIT
rm -f "$pre_migrate"
# Pruning old releases is housekeeping; failing at it doesn't fail the deploy.
ls -1dt /opt/quote-mcp/releases/* | tail -n +4 | xargs -r rm -rf || echo "couldn't prune old releases" >&2
`);
  await writeDeployed({ branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(["rev-parse", "HEAD"]), local: true, dirty: git(["status", "--porcelain"]) !== "" });
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const DEPLOYED = "/var/lib/quote-mcp/deployed.json";

/** Records what the server now runs ({ branch, commit, local, dirty, at }), for /health and tools/quote-status.mjs. */
async function writeDeployed(record) {
  const encoded = Buffer.from(JSON.stringify({ ...record, at: new Date().toISOString() })).toString("base64");
  await runAsRoot(`printf %s ${shellQuote(encoded)} | base64 -d > ${DEPLOYED}.new && chmod 0644 ${DEPLOYED}.new && mv ${DEPLOYED}.new ${DEPLOYED} && echo`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const known = new Set(["--provision", "--env", "--import-drupal", "--skip-tests"]);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--env")) return pushEnv();
  if (argv.includes("--import-drupal")) return importDrupal();
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
