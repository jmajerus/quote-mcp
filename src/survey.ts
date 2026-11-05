import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Suspect, dropCommonUnknowns, loadDictionary, suspectTokens } from "./ocr.js";
import { type ParsedNote, gradeOf, parseNote } from "./parse.js";
import { ZoteroClient, zoteroConfig } from "./zotero.js";

/**
 * Phase 0: reads every Zotero quote note, parses each one, and reports what the import would make of
 * them. Read-only. Notes are cached in <out>/cache, so a re-run after a parser change needs no network;
 * pass --refresh to fetch again.
 *
 *   npm run survey [-- --refresh] [-- --out <dir>]
 *       Zotero notes in QUOTE_ZOTERO_LIBRARY.
 *
 * Writes <out>/report.md (counts, examples, tag inventory) and <out>/notes.jsonl (every quote as parsed).
 */

const EXAMPLES = 8;

interface Row {
  key: string;
  parent: string | null;
  parentTitle: string | null;
  parentType: string | null;
  tags: string[];
  parsed: ParsedNote;
  suspects: Suspect[];
}

function args() {
  const argv = process.argv.slice(2);
  const at = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  // An option ignored would give a different report from the one asked for.
  argv.forEach((arg, i) => {
    if (arg.startsWith("-") && arg !== "--refresh" && arg !== "--out") throw new Error(`The survey doesn't take ${arg}: it reads Zotero notes only.`);
    if (!arg.startsWith("-") && argv[i - 1] !== "--out") throw new Error(`The survey doesn't take ${arg}.`);
  });
  return { refresh: argv.includes("--refresh"), out: at("--out") ?? "survey" };
}

function progress(label: string) {
  return (done: number, total: number) => process.stderr.write(`\r${label}: ${done} of ${total}`);
}

/** Reads JSON from the cache, or fetches it and caches it. */
async function cached<T>(file: string, refresh: boolean, fetch: () => Promise<T>): Promise<T> {
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  const value = await fetch();
  process.stderr.write("\n");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return value;
}

const clientFor = (library?: string) => new ZoteroClient({ ...zoteroConfig(), ...(library ? { library } : {}) }, (text) => process.stderr.write(`\n${text}`));

async function zoteroRows(out: string, refresh: boolean): Promise<Row[]> {
  const dir = join(out, "cache");
  if (!refresh && existsSync(join(dir, "notes.json"))) process.stderr.write(`Using cached notes in ${dir} (--refresh to fetch again).\n`);
  const notes = await cached(join(dir, "notes.json"), refresh, () => clientFor().getAll("items", { itemType: "note" }, progress("Notes")));
  const parentKeys = [...new Set(notes.map((n) => n.data.parentItem).filter((k): k is string => !!k))];
  const parentList = await cached(join(dir, "parents.json"), refresh, () => clientFor().getByKeys(parentKeys, progress("Parent items")));
  const parents = new Map(parentList.map((p) => [p.key, p]));
  return notes.map((n) => {
    const tags = (n.data.tags ?? []).map((t) => t.tag);
    const parsed = parseNote(n.data.note ?? "", tags);
    if (parsed.kind === "other") parsed.commentary = plain(n.data.note ?? "");
    const parent = n.data.parentItem ? parents.get(n.data.parentItem) : undefined;
    return { key: n.key, parent: n.data.parentItem ?? null, parentTitle: parent?.data.title ?? null, parentType: parent?.data.itemType ?? null, tags, parsed, suspects: [] };
  });
}

function applyOcr(rows: Row[]) {
  const dict = loadDictionary();
  const byNote = new Map<string, Suspect[]>();
  for (const r of rows) if (r.parsed.kind === "quote" && r.parsed.text) byNote.set(r.key, suspectTokens(r.parsed.text, dict));
  const kept = dropCommonUnknowns(byNote);
  for (const r of rows) {
    const suspects = kept.get(r.key);
    if (!suspects) continue;
    r.suspects = suspects;
    r.parsed.flags.push("ocr_suspect");
    r.parsed.grade = gradeOf(r.parsed);
  }
}

const count = <T>(items: T[], key: (item: T) => string | string[] | undefined) => {
  const counts = new Map<string, number>();
  for (const item of items) for (const k of [key(item)].flat()) if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ⏎ ");
const snippet = (text: string | undefined, max = 160) => cell(!text ? "" : text.length > max ? `${text.slice(0, max)}…` : text);

function table(rows: [string, number][], of: number, head: string, unit = "Notes"): string {
  return [`| ${head} | ${unit} | Share |`, "|---|---:|---:|", ...rows.map(([k, n]) => `| ${cell(k)} | ${n} | ${pct(n, of)} |`)].join("\n");
}

function examples(rows: Row[], detail: (row: Row) => string = (r) => snippet(r.parsed.text)): string {
  if (!rows.length) return "_None._";
  const shown = rows.slice(0, EXAMPLES).map((r) => `| \`${r.key}\` | ${snippet(r.parentTitle ?? "(standalone)", 50)} | ${detail(r)} |`);
  return ["| Quote | Source | Detail |", "|---|---|---|", ...shown, rows.length > EXAMPLES ? `\n${rows.length - EXAMPLES} more in notes.jsonl.` : ""].join("\n");
}

/** Spellings of one tag that differ only in case, spacing, hyphens, or a plural s. */
function variantGroups(tags: [string, number][]): string[][] {
  const groups = new Map<string, string[]>();
  for (const [tag] of tags) {
    const k = tag.toLowerCase().replace(/[-_\s]+/g, " ").replace(/s$/, "").trim();
    groups.set(k, [...(groups.get(k) ?? []), tag]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function report(rows: Row[], source: string): string {
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const sources = new Set(quotes.map((r) => r.parent).filter(Boolean));
  const withFlag = (flag: string) => quotes.filter((r) => r.parsed.flags.includes(flag as never));
  const tagCounts = count(quotes, (r) => r.tags);
  const tagged = quotes.filter((r) => r.tags.length).length;
  const tokens = count(quotes, (r) => r.suspects.map((s) => (s.suggestion ? `${s.token} → ${s.suggestion}` : s.token)));
  const perSource = count(quotes.filter((r) => r.parent), (r) => r.parent ?? undefined);
  const kwic = quotes.flatMap((r) => r.parsed.kwic);

  return `# Quote survey: ${source}

Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} from ${rows.length} notes or quote spans. Read-only: nothing was written anywhere.

## By kind

${table(count(rows, (r) => r.parsed.kind), rows.length, "Kind")}

- **${quotes.length} quotes** from **${sources.size} works**${perSource.length ? `; the most from one work is ${perSource[0][1]}` : ""}.
- Quotes without a work (nothing to cite): ${quotes.filter((r) => !r.parent).length}.
- Quotes with at least one tag: ${tagged} (${pct(tagged, quotes.length)}).
- Keyword-in-context phrases: ${kwic.length}${kwic.length ? `, e.g. ${kwic.slice(0, 3).map((k) => `"${k.phrase}" → \`${k.concept}\``).join(", ")}` : ""}.

## Quotes by form and grade

${table(count(quotes, (r) => r.parsed.form), quotes.length, "Form")}

${table(count(quotes, (r) => r.parsed.grade), quotes.length, "Grade")}

A: clean apart from a missing locator. B: extracted, with flags. C: needs a person to split it.

## Flags

${table(count(quotes, (r) => r.parsed.flags), quotes.length, "Flag")}

## Locators

${table(count(quotes, (r) => r.parsed.locator?.kind ?? "none"), quotes.length, "Kind")}

Quotes without a locator, by work type (web pages and articles may not need one):

${table(count(withFlag("no_locator"), (r) => r.parentType ?? "(standalone)"), withFlag("no_locator").length, "Work type")}

## Grade C: needs a person

${examples(quotes.filter((r) => r.parsed.grade === "C"), (r) => `${r.parsed.problems.join("; ")}: ${snippet(r.parsed.commentary ? `[${r.parsed.commentary}] ${r.parsed.text}` : r.parsed.text, 120)}`)}

## Examples by flag

### commentary_mixed

${examples(withFlag("commentary_mixed"), (r) => `quote: ${snippet(r.parsed.text, 80)} · commentary: ${snippet(r.parsed.commentary, 80)}`)}

### unbalanced_quotes

${examples(withFlag("unbalanced_quotes"))}

### chapter_author

${examples(withFlag("chapter_author"), (r) => `${cell(r.parsed.locator?.raw ?? "")} → ${cell(r.parsed.chapterAuthor ?? "")}`)}

### kindle_locator

${examples(withFlag("kindle_locator"), (r) => cell(r.parsed.locator?.raw ?? ""))}

### title_tag_only

${examples(withFlag("title_tag_only"), (r) => `title: ${cell(r.parsed.titleTags.join(", "))} · tags: ${cell(r.tags.join(", "))}`)}

### compound_tag

${examples(withFlag("compound_tag"), (r) => cell(r.tags.join(" · ")))}

### long

${examples(withFlag("long"), (r) => `${r.parsed.text?.length} characters`)}

### ocr_suspect

${examples(withFlag("ocr_suspect"), (r) => cell(r.suspects.map((s) => (s.suggestion ? `${s.token} → ${s.suggestion}` : `${s.token} (${s.reason})`)).join(", ")))}

Most frequent suspect words:

${tokens.length ? ["| Word | Quotes |", "|---|---:|", ...tokens.slice(0, 40).map(([t, n]) => `| ${cell(t)} | ${n} |`)].join("\n") : "_None._"}

## Notes that aren't quotes

### other (no quote marks or quote markup)

${examples(rows.filter((r) => r.parsed.kind === "other"), (r) => snippet(r.parsed.commentary ?? r.parsed.text ?? r.key))}

### catalog (skipped)

${examples(rows.filter((r) => r.parsed.kind === "catalog"), () => "")}

## Tags on quotes

${tagCounts.length} distinct tags.

${tagCounts.length ? ["| Tag | Quotes |", "|---|---:|", ...tagCounts.slice(0, 60).map(([t, n]) => `| ${cell(t)} | ${n} |`)].join("\n") : "_None._"}

Spellings that may be one tag:

${variantGroups(tagCounts).map((g) => `- ${g.map((t) => `\`${t}\``).join(", ")}`).join("\n") || "_None._"}
`;
}

function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const { refresh, out } = args();
  const rows = await zoteroRows(out, refresh);
  applyOcr(rows);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "notes.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(out, "report.md"), report(rows, "Zotero notes"));
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const grades = count(quotes, (r) => r.parsed.grade).map(([g, n]) => `${g} ${n}`).join(", ");
  process.stderr.write(`${rows.length} notes, ${quotes.length} quotes (${grades}). Report: ${join(out, "report.md")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
