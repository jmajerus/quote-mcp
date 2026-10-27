import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Suspect, dropCommonUnknowns, loadDictionary, suspectTokens } from "./ocr.js";
import { type ParsedNote, gradeOf, parseNote } from "./parse.js";
import { type ApiItem, ZoteroClient, zoteroConfig } from "./zotero.js";

/**
 * Phase 0: reads every note in the Zotero library, parses each one, and reports what the import would
 * make of them. Read-only. Notes and their parent items are cached in survey/cache, so a re-run after a
 * parser change needs no network; pass --refresh to fetch again.
 *
 *   npm run survey [-- --refresh] [-- --out <dir>]
 *
 * Writes <out>/report.md (counts, examples, tag inventory) and <out>/notes.jsonl (every note as parsed).
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
  return { refresh: argv.includes("--refresh"), out: at("--out") ?? "survey" };
}

function progress(label: string) {
  return (done: number, total: number) => process.stderr.write(`\r${label}: ${done} of ${total}`);
}

async function load(out: string, refresh: boolean): Promise<{ notes: ApiItem[]; parents: Map<string, ApiItem> }> {
  const dir = join(out, "cache");
  const notesFile = join(dir, "notes.json");
  const parentsFile = join(dir, "parents.json");
  if (!refresh && existsSync(notesFile) && existsSync(parentsFile)) {
    process.stderr.write(`Using cached notes in ${dir} (--refresh to fetch again).\n`);
    const parents = JSON.parse(readFileSync(parentsFile, "utf8")) as ApiItem[];
    return { notes: JSON.parse(readFileSync(notesFile, "utf8")), parents: new Map(parents.map((p) => [p.key, p])) };
  }
  const client = new ZoteroClient(zoteroConfig(), (text) => process.stderr.write(`\n${text}`));
  const notes = await client.getAll("items", { itemType: "note" }, progress("Notes"));
  process.stderr.write("\n");
  const parentKeys = [...new Set(notes.map((n) => n.data.parentItem).filter((k): k is string => !!k))];
  const parents = await client.getByKeys(parentKeys, progress("Parent items"));
  process.stderr.write("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(notesFile, JSON.stringify(notes));
  writeFileSync(parentsFile, JSON.stringify(parents));
  return { notes, parents: new Map(parents.map((p) => [p.key, p])) };
}

const count = <T>(items: T[], key: (item: T) => string | string[] | undefined) => {
  const counts = new Map<string, number>();
  for (const item of items) for (const k of [key(item)].flat()) if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ⏎ ");
const snippet = (text: string | undefined, max = 160) => cell(!text ? "" : text.length > max ? `${text.slice(0, max)}…` : text);

function table(rows: [string, number][], of: number, head: string): string {
  return [`| ${head} | Notes | Share |`, "|---|---:|---:|", ...rows.map(([k, n]) => `| ${cell(k)} | ${n} | ${pct(n, of)} |`)].join("\n");
}

function examples(rows: Row[], detail: (row: Row) => string = (r) => snippet(r.parsed.text)): string {
  if (!rows.length) return "_None._";
  const shown = rows.slice(0, EXAMPLES).map((r) => `| \`${r.key}\` | ${snippet(r.parentTitle ?? "(standalone)", 50)} | ${detail(r)} |`);
  return ["| Note | Book | Detail |", "|---|---|---|", ...shown, rows.length > EXAMPLES ? `\n${rows.length - EXAMPLES} more in notes.jsonl.` : ""].join("\n");
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

function report(rows: Row[], total: number): string {
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const books = new Set(quotes.map((r) => r.parent).filter(Boolean));
  const withFlag = (flag: string) => quotes.filter((r) => r.parsed.flags.includes(flag as never));
  const tagCounts = count(quotes, (r) => r.tags);
  const tagged = quotes.filter((r) => r.tags.length).length;
  const tokens = count(quotes, (r) => r.suspects.map((s) => (s.suggestion ? `${s.token} → ${s.suggestion}` : s.token)));
  const perBook = count(quotes.filter((r) => r.parent), (r) => r.parent ?? undefined);

  return `# Quote survey

Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} from ${total} notes. Read-only: nothing was written to Zotero.

## Notes by kind

${table(count(rows, (r) => r.parsed.kind), total, "Kind")}

- **${quotes.length} quotes** from **${books.size} items**${perBook.length ? `; the most from one item is ${perBook[0][1]}` : ""}.
- Standalone quote notes (no parent item, so nothing to cite): ${quotes.filter((r) => !r.parent).length}.
- Quotes with at least one tag: ${tagged} (${pct(tagged, quotes.length)}).

## Quotes by form and grade

${table(count(quotes, (r) => r.parsed.form), quotes.length, "Form")}

${table(count(quotes, (r) => r.parsed.grade), quotes.length, "Grade")}

A: clean apart from a missing locator. B: extracted, with flags. C: needs a person to split it.

## Flags

${table(count(quotes, (r) => r.parsed.flags), quotes.length, "Flag")}

## Locators

${table(count(quotes, (r) => r.parsed.locator?.kind ?? "none"), quotes.length, "Kind")}

Quotes without a locator, by item type (web pages and articles may not need one):

${table(count(withFlag("no_locator"), (r) => r.parentType ?? "(standalone)"), withFlag("no_locator").length, "Item type")}

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

${tokens.length ? ["| Word | Notes |", "|---|---:|", ...tokens.slice(0, 40).map(([t, n]) => `| ${cell(t)} | ${n} |`)].join("\n") : "_None._"}

## Notes that aren't quotes

### other (no quote marks or quote markup)

${examples(rows.filter((r) => r.parsed.kind === "other"), (r) => snippet(r.parsed.commentary ?? r.parsed.text ?? r.key))}

### catalog (skipped)

${examples(rows.filter((r) => r.parsed.kind === "catalog"), () => "")}

## Tags on quote notes

${tagCounts.length} distinct tags.

${tagCounts.length ? ["| Tag | Quotes |", "|---|---:|", ...tagCounts.slice(0, 60).map(([t, n]) => `| ${cell(t)} | ${n} |`)].join("\n") : "_None._"}

Spellings that may be one tag:

${variantGroups(tagCounts).map((g) => `- ${g.map((t) => `\`${t}\``).join(", ")}`).join("\n") || "_None._"}
`;
}

/** The text of an "other" note, so the report can show it. */
function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const { refresh, out } = args();
  const { notes, parents } = await load(out, refresh);
  const dict = loadDictionary();

  const rows: Row[] = notes.map((n) => {
    const tags = (n.data.tags ?? []).map((t) => t.tag);
    const parsed = parseNote(n.data.note ?? "", tags);
    if (parsed.kind === "other") parsed.commentary = plain(n.data.note ?? "");
    const parent = n.data.parentItem ? parents.get(n.data.parentItem) : undefined;
    return { key: n.key, parent: n.data.parentItem ?? null, parentTitle: parent?.data.title ?? null, parentType: parent?.data.itemType ?? null, tags, parsed, suspects: [] };
  });

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

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "notes.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(out, "report.md"), report(rows, notes.length));
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const grades = count(quotes, (r) => r.parsed.grade).map(([g, n]) => `${g} ${n}`).join(", ");
  process.stderr.write(`${notes.length} notes, ${quotes.length} quotes (${grades}). Report: ${join(out, "report.md")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
