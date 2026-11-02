import fs from "node:fs";
import { d1ConfigFrom } from "./d1-http.js";

/**
 * Every setting quote-mcp reads, by what it's for, with its default, so `quote-mcp config` can say what's
 * set, where from, and what each feature still needs, and .env.example can stay short. Most have
 * defaults; a new install needs only the Zotero library and key.
 *
 * A setting comes from the environment (.env, or /etc/quote-mcp/env on the LXC). The public site's two
 * choices, `public` and `notes`, can instead be in vocab/site.md's settings header, kept in git with the
 * site's title; the environment overrides them.
 */

export interface Setting {
  name: string;
  group: string;
  about: string;
  secret?: boolean;
  /** The default, as it's shown. */
  fallback?: string;
  /** The field in vocab/site.md's settings header that can give it instead. */
  site?: string;
}

export const SETTINGS: Setting[] = [
  { name: "QUOTE_ZOTERO_LIBRARY", group: "Zotero (required)", about: "the Zotero library to read: users/<id> or groups/<id>" },
  { name: "QUOTE_ZOTERO_API_KEY", group: "Zotero (required)", about: "a Zotero API key; read-only is enough", secret: true },
  { name: "QUOTE_ZOTERO_SOURCES", group: "Import", about: "other Zotero libraries to import quote notes from, comma-separated" },
  { name: "QUOTE_DRUPAL_URL", group: "Import", about: "the old Drupal site's database (mysql://…), read-only", secret: true },
  { name: "QUOTE_DICTIONARY", group: "Import", about: "a word list for the OCR check", fallback: "/usr/share/dict/words" },
  { name: "QUOTE_ZOTERO_API", group: "Import", about: "the Zotero API", fallback: "https://api.zotero.org" },
  { name: "QUOTE_DB", group: "Service", about: "the quote store", fallback: "data/quotes.db" },
  { name: "QUOTE_HOST", group: "Service", about: "the address to listen on", fallback: "0.0.0.0" },
  { name: "QUOTE_PORT", group: "Service", about: "the port for MCP, the admin pages, and the API", fallback: "8010" },
  { name: "ACCESS_TEAM_DOMAIN", group: "Service", about: "the Cloudflare Access team whose tokens proxied requests need (https://<team>.cloudflareaccess.com); unset, they are refused" },
  { name: "QUOTE_SETS", group: "Service", about: "the concept sets", fallback: "vocab/sets.json" },
  { name: "QUOTE_TERMS_SYNC", group: "Concepts from terminology-mcp", about: "on: the server follows terminology-mcp's human-work scheme every minute", fallback: "off" },
  { name: "TERMINOLOGY_BASE", group: "Concepts from terminology-mcp", about: "terminology-mcp on the LAN, where progress reports name the caller; off turns following off", fallback: "http://terminology-mcp.localdomain:8000" },
  { name: "QUOTE_MAP_DIR", group: "Maps", about: "quote-atlas's built maps, served at /map/" },
  { name: "QUOTE_PUBLIC", group: "Public site", about: "none, catalogue (no quoted text), or quotes", fallback: "none", site: "public" },
  { name: "QUOTE_PUBLIC_NOTES", group: "Public site", about: "notes on the public site: none or all", fallback: "none", site: "notes" },
  { name: "QUOTE_INTRO", group: "Public site", about: "the front page's title, introduction, and settings", fallback: "vocab/site.md" },
  { name: "QUOTE_SNAPSHOT", group: "Public site", about: "the public snapshot", fallback: "public.db beside the store" },
  { name: "QUOTE_PUBLIC_PORT", group: "Public site", about: "a port serving only the public site, for a hostname with no login" },
  { name: "QUOTE_D1_PROXY_URL", group: "Public replica in D1", about: "the D1 proxy Worker (worker/proxy.ts)" },
  { name: "QUOTE_D1_PROXY_TOKEN", group: "Public replica in D1", about: "the proxy's token (its D1_PROXY_TOKEN secret)", secret: true },
  { name: "CLOUDFLARE_ACCOUNT_ID", group: "Public replica in D1", about: "instead of the proxy: Cloudflare's REST API, with this account" },
  { name: "CLOUDFLARE_API_TOKEN", group: "Public replica in D1", about: "…a token that can edit D1", secret: true },
  { name: "QUOTE_D1_DATABASE_ID", group: "Public replica in D1", about: "…and the database", fallback: "worker/wrangler.jsonc's database_id" },
  { name: "QUOTE_DEPLOY_HOST", group: "Deploy", about: "where `npm run deploy` installs", fallback: "authoring@quote-mcp.localdomain" },
  { name: "AUTHORING_DEPLOY_PASSWORD", group: "Deploy", about: "the deploy account's SSH password", secret: true },
  { name: "QUOTE_STATUS_URL", group: "Deploy", about: "the server the VS Code status item asks", fallback: "http://quote-mcp.localdomain:8000" },
];

export type Source = "environment" | "vocab/site.md" | "default" | "unset";

/** A setting's value and where it came from. */
export function resolve(s: Setting, env: NodeJS.ProcessEnv, site: Record<string, string>): { value: string | null; source: Source } {
  const fromEnv = env[s.name]?.trim();
  if (fromEnv) return { value: fromEnv, source: "environment" };
  const fromSite = s.site ? site[s.site]?.trim() : undefined;
  if (fromSite) return { value: fromSite, source: "vocab/site.md" };
  if (s.fallback !== undefined) return { value: s.fallback, source: "default" };
  return { value: null, source: "unset" };
}

/** The value of a setting that vocab/site.md can give, the environment first. */
export function siteSetting(name: string, env: NodeJS.ProcessEnv, site: Record<string, string>): string {
  return resolve(SETTINGS.find((s) => s.name === name)!, env, site).value ?? "";
}

interface Feature { name: string; on: boolean; note: string }

/** Each feature, whether it's on, and what it still needs. */
function features(env: NodeJS.ProcessEnv, site: Record<string, string>, wrangler: string): Feature[] {
  const has = (name: string) => !!env[name]?.trim();
  const missing = (names: string[]) => names.filter((n) => !has(n));
  const level = siteSetting("QUOTE_PUBLIC", env, site);
  let d1: Feature;
  try {
    const config = d1ConfigFrom(env, wrangler);
    d1 = config
      ? { name: "Public replica in D1", on: level !== "none", note: config.endpoint ? `through the proxy at ${config.endpoint}` : "through Cloudflare's REST API" }
      : { name: "Public replica in D1", on: false, note: "needs QUOTE_D1_PROXY_URL and QUOTE_D1_PROXY_TOKEN (or the REST API's settings)" };
    if (config && level === "none") d1.note += "; off while the public site is none";
  } catch (error) {
    d1 = { name: "Public replica in D1", on: false, note: (error as Error).message };
  }
  const zotero = missing(["QUOTE_ZOTERO_LIBRARY", "QUOTE_ZOTERO_API_KEY"]);
  const mapDir = env.QUOTE_MAP_DIR?.trim();
  const terminology = env.TERMINOLOGY_BASE?.trim().toLowerCase() === "off";
  const following = env.QUOTE_TERMS_SYNC?.trim().toLowerCase() === "on";
  return [
    { name: "Import from Zotero", on: !zotero.length, note: zotero.length ? `needs ${zotero.join(" and ")}` : "" },
    { name: "Import from the old site", on: has("QUOTE_DRUPAL_URL"), note: has("QUOTE_DRUPAL_URL") ? "" : "off without QUOTE_DRUPAL_URL" },
    { name: "Concepts from terminology-mcp", on: following && !terminology, note: !following ? "off; the store's concepts change only by hand (`quote-mcp terms`) until QUOTE_TERMS_SYNC=on" : terminology ? "off: TERMINOLOGY_BASE is off" : "" },
    { name: "Maps at /map/", on: !!mapDir && fs.existsSync(mapDir), note: !mapDir ? "off without QUOTE_MAP_DIR" : fs.existsSync(mapDir) ? "" : `${mapDir} doesn't exist here` },
    { name: "Public site", on: level !== "none", note: level === "none" ? "off; set public: in vocab/site.md, or QUOTE_PUBLIC" : `level ${level}` },
    { name: "Public-only port", on: level !== "none" && has("QUOTE_PUBLIC_PORT"), note: has("QUOTE_PUBLIC_PORT") ? "" : "off without QUOTE_PUBLIC_PORT" },
    d1,
  ];
}

/** What `quote-mcp config` prints: each setting by group, then each feature. Secrets show only as set. */
export function configReport(env: NodeJS.ProcessEnv, site: Record<string, string>, wrangler: string): string {
  const lines: string[] = [];
  let group = "";
  for (const s of SETTINGS) {
    if (s.group !== group) lines.push(`${lines.length ? "\n" : ""}${(group = s.group)}`);
    const { value, source } = resolve(s, env, site);
    const shown = value === null ? "—" : s.secret && source === "environment" ? "(set)" : value;
    lines.push(`  ${s.name.padEnd(26)} ${shown.padEnd(36)} ${source === "unset" ? "" : source === "environment" ? "" : `[${source}]`}`.trimEnd());
  }
  lines.push("\nFeatures");
  for (const f of features(env, site, wrangler)) lines.push(`  ${f.on ? "on " : "off"}  ${f.name}${f.note ? `: ${f.note}` : ""}`);
  return lines.join("\n");
}
