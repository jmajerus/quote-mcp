#!/usr/bin/env node
// Loads WordNet onto the WordNet Oxigraph server (docs/wordnet.md), which quote-mcp asks for each concept's synset.
//
//   node tools/wordnet-load.mjs [--edition 2025] [--host root@wordnet.localdomain] [--senses-only]
//
// Two graphs:
//   urn:wordnet:graph:oewn-<edition>   Open English WordNet, as released (CC BY 4.0). Loaded on the server with
//                                      `oxigraph load`, the service stopped for the minute it takes, since one
//                                      HTTP transaction of 3.7 million triples is more than the server handles.
//                                      Skipped when it's already there: a new edition is a new graph.
//   urn:wordnet:graph:pwn30-senses     Princeton WordNet 3.0's senses ("anger-noun-1", the names the old site's
//                                      purl.org links use) keyed on their Interlingual Index id, which Open
//                                      English WordNet's synsets carry as wn:ili. Built here from Princeton's
//                                      index.sense and CILI's ili-map-pwn30.tab, and replaced whole over HTTP.
//
// The WordNet server is its own container: never point this at the shared Oxigraph, whose other tools' queries
// scan every graph (docs/wordnet.md).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const edition = opt("--edition", "2025");
// The edition names files and a graph in a shell script run as root on the server: a year, nothing else.
if (!/^\d{4}$/.test(edition)) throw new Error(`--edition takes a year, such as 2025; got ${JSON.stringify(edition)}`);
const host = opt("--host", "root@wordnet.localdomain");
const base = (process.env.WORDNET_SPARQL || "http://wordnet.localdomain:7878").replace(/\/+$/, "");
const OEWN = `urn:wordnet:graph:oewn-${edition}`;
const SENSES = "urn:wordnet:graph:pwn30-senses";
const SENSE = "urn:wordnet:pwn30-sense";
const POS = { 1: "noun", 2: "verb", 3: "adjective", 4: "adverb", 5: "adjectivesatellite" };
const LETTER = { 1: "n", 2: "v", 3: "a", 4: "r", 5: "a" };

async function ask(graph) {
  const res = await fetch(`${base}/query`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/sparql-results+json" },
    body: new URLSearchParams({ query: `ASK { GRAPH <${graph}> { ?s ?p ?o } }` }), signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${base} answered ${res.status}`);
  return (await res.json()).boolean;
}

async function guard() {
  // A server holding Concept Clusters' or terminology-mcp's data is the shared one.
  const res = await fetch(`${base}/query`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/sparql-results+json" },
    body: new URLSearchParams({ query: 'ASK { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } FILTER(!STRSTARTS(STR(?g), "urn:wordnet:")) } }' }),
    signal: AbortSignal.timeout(60_000),
  });
  if ((await res.json()).boolean) throw new Error(`${base} holds data that isn't WordNet's: is this the shared Oxigraph? Stopping.`);
}

function ssh(script) {
  execFileSync("ssh", ["-o", "BatchMode=yes", host, script], { stdio: "inherit" });
}

async function loadOewn() {
  const file = `english-wordnet-${edition}.ttl.gz`;
  const url = `https://github.com/globalwordnet/english-wordnet/releases/download/${edition}-edition/${file}`;
  console.log(`Loading ${file} into ${OEWN} on ${host}`);
  const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const ttl = `english-wordnet-${edition}.ttl`;
  ssh(`set -e
cd /var/tmp && curl -sfL -o ${q(file)} ${q(url)}
gunzip -f ${q(file)}
systemctl stop oxigraph
trap 'systemctl start oxigraph' EXIT
oxigraph load --location /var/lib/oxigraph --file ${q(ttl)} --graph ${q(OEWN)}
rm -f ${q(ttl)}`);
  for (let i = 0; i < 60; i++) {
    try { if (await ask(OEWN)) return; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${OEWN} isn't answering after the load`);
}

async function loadSenses() {
  const dir = mkdtempSync(path.join(tmpdir(), "wordnet-"));
  const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  writeFileSync(path.join(dir, "wn30.tar.gz"), await get("https://wordnetcode.princeton.edu/3.0/WordNet-3.0.tar.gz"));
  const index = execFileSync("tar", ["-xzOf", path.join(dir, "wn30.tar.gz"), "WordNet-3.0/dict/index.sense"], { maxBuffer: 64 << 20 }).toString();
  const ili = new Map();
  for (const line of (await get("https://raw.githubusercontent.com/globalwordnet/cili/master/ili-map-pwn30.tab")).toString().split("\n")) {
    const [id, offset] = line.split("\t");
    if (offset) ili.set(offset.trim().replace(/-s$/, "-a"), id);
  }
  const lines = [];
  let missing = 0;
  for (const line of index.split("\n")) {
    if (!line) continue;
    const [key, offset, n] = line.split(" ");
    const [lemma, rest] = key.split("%");
    const id = ili.get(`${offset}-${LETTER[rest[0]]}`);
    if (!id) { missing++; continue; }
    lines.push(`<http://globalwordnet.org/ili/${id}> <${SENSE}> ${JSON.stringify(`${lemma}-${POS[rest[0]]}-${n}`)} .`);
  }
  writeFileSync(path.join(dir, "senses.nt"), lines.join("\n") + "\n");
  const res = await fetch(`${base}/store?graph=${encodeURIComponent(SENSES)}`, {
    method: "PUT", headers: { "content-type": "application/n-triples" }, body: readFileSync(path.join(dir, "senses.nt")),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`replacing ${SENSES}: ${res.status} ${await res.text()}`);
  console.log(`${SENSES}: ${lines.length} senses${missing ? ` (${missing} with no ILI)` : ""}`);
}

await guard();
if (!args.includes("--senses-only") && !(await ask(OEWN))) await loadOewn();
await loadSenses();
