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
  --env            copy QUOTE_ZOTERO_LIBRARY, QUOTE_ZOTERO_API_KEY, QUOTE_ZOTERO_SOURCES, and
                   QUOTE_DRUPAL_URL from .env into the server's /etc/quote-mcp/env (mode 0640)
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

/** Sets the server's Zotero and old-site settings from this machine's .env, so keys never pass through a chat or a command line. */
async function pushEnv() {
  const names = ["QUOTE_ZOTERO_LIBRARY", "QUOTE_ZOTERO_API_KEY", "QUOTE_ZOTERO_SOURCES", "QUOTE_DRUPAL_URL"];
  const library = process.env.QUOTE_ZOTERO_LIBRARY ?? "";
  if (!/^(users|groups)\/\d+$/.test(library)) throw new Error(`QUOTE_ZOTERO_LIBRARY should be "users/<user id>" or "groups/<group id>", not "${library}".`);
  const lines = names.filter((n) => process.env[n]).map((n) => `${n}=${process.env[n]}`).join("\n");
  const encoded = Buffer.from(`${lines}\n`).toString("base64");
  await runAsRoot(`
set -euo pipefail
f=/etc/quote-mcp/env
grep -v ${names.map((n) => `-e '^${n}='`).join(" ")} "$f" > "$f.new" || true
printf %s ${shellQuote(encoded)} | base64 -d >> "$f.new"
chown root:quote "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
cut -d= -f1 "$f" | tr '\\n' ' '; echo
if systemctl is-active --quiet quote-mcp.service; then systemctl restart quote-mcp.service; fi`);
}

async function importDrupal() {
  await runAsRoot(`set -euo pipefail\n${asQuote("import")}`);
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `quote-mcp-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "package.json", "package-lock.json"]);
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
install -m 0644 deploy/quote-mcp.service deploy/quote-import.service deploy/quote-import.timer \\
  deploy/quote-backup.service deploy/quote-backup.timer /etc/systemd/system/
previous=$(readlink /opt/quote-mcp/current || true)
echo "previous=$previous"
ln -sfn "$release" /opt/quote-mcp/current.new && mv -T /opt/quote-mcp/current.new /opt/quote-mcp/current
systemctl daemon-reload
set -a; . /etc/quote-mcp/env; set +a
if [ ! -f "$QUOTE_DB" ]; then
  echo "No store yet: running the first import, the old site included."
  ${asQuote("import")}
else
  ${asQuote("migrate")}
fi
systemctl enable --quiet quote-mcp.service quote-import.timer quote-backup.timer
systemctl start quote-import.timer quote-backup.timer
systemctl restart quote-mcp.service
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$QUOTE_PORT/health"; then echo; echo "installed=${id}"; break; fi
  sleep 1
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$QUOTE_PORT/health"; then
  journalctl -u quote-mcp.service -n 20 --no-pager || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/quote-mcp/current
    systemctl restart quote-mcp.service
    echo "rolled_back=$previous"
  fi
  exit 1
fi
ls -1dt /opt/quote-mcp/releases/* | tail -n +4 | xargs -r rm -rf
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
