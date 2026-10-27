import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DrupalSite, drupalUrl, loadDrupal } from "./drupal.js";
import { type Suspect, dropCommonUnknowns, loadDictionary, suspectTokens } from "./ocr.js";
import { type ParsedNote, gradeOf, parseNote, splitQuotes } from "./parse.js";
import { type ApiItem, ZoteroClient, zoteroConfig } from "./zotero.js";

/**
 * Phase 0: reads every quote a source holds, parses each one, and reports what the import would make
 * of them. Read-only. Sources are cached in <out>/cache, so a re-run after a parser change needs no
 * network; pass --refresh to fetch again.
 *
 *   npm run survey [-- --refresh] [-- --out <dir>]
 *       Zotero notes in QUOTE_ZOTERO_LIBRARY.
 *   npm run survey -- --source drupal [--libraries users/1,groups/2] [--compare a.jsonl,b.jsonl] [--out <dir>]
 *       The old Drupal site (QUOTE_DRUPAL_URL), with each work matched to the Zotero items in --libraries
 *       and each quote compared with earlier Zotero surveys.
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
  const list = (name: string) => at(name)?.split(",").map((s) => s.trim()).filter(Boolean);
  const source = at("--source") ?? "zotero";
  if (source !== "zotero" && source !== "drupal") throw new Error(`--source must be zotero or drupal, not "${source}".`);
  return {
    source, refresh: argv.includes("--refresh"), out: at("--out") ?? (source === "drupal" ? "survey/drupal" : "survey"),
    libraries: list("--libraries"), compare: list("--compare") ?? ["survey/notes.jsonl", "survey/group-61098/notes.jsonl"].filter(existsSync),
  };
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

function drupalRows(site: DrupalSite): Row[] {
  const rows: Row[] = [];
  for (const work of site.works) {
    if (!work.notes.trim()) continue;
    const { quotes, outside } = splitQuotes(work.notes);
    // A work whose notes hold no quote span is read as a single note, so the report shows what it is.
    const pieces = quotes.length ? quotes : [{ html: work.notes, concepts: [] }];
    for (const [i, q] of pieces.entries()) {
      const parsed = parseNote(q.html, q.concepts);
      if (parsed.kind === "other") parsed.commentary = plain(q.html);
      if (i === 0 && outside) parsed.commentary = [parsed.commentary, outside].filter(Boolean).join("\n\n");
      rows.push({ key: `drupal:${work.nid}#${i + 1}`, parent: `drupal:${work.nid}`, parentTitle: work.title, parentType: work.type, tags: q.concepts, parsed, suspects: [] });
    }
  }
  for (const q of site.quotes) {
    const parsed = parseNote(`<p>${q.body}</p>`);
    rows.push({ key: `drupal-quote:${q.nid}`, parent: null, parentTitle: q.citation ?? (q.author ? `(${q.author})` : q.title), parentType: "Quotes module", tags: [], parsed, suspects: [] });
  }
  return rows;
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

function report(rows: Row[], source: string, extra = ""): string {
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
${extra}`;
}

/** A title compared loosely: case, accents, punctuation, and a subtitle after ":" ignored (corpus-mcp's rule). */
function normalizedTitle(title: string | null | undefined): string {
  return String(title ?? "").split(/[:.?!]\s/)[0].toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}

/** Quote text compared loosely, for finding one quote in two sources. */
const quoteKey = (text: string | undefined) => (text ?? "").toLowerCase().replace(/[^a-z]+/g, "").slice(0, 120);

function drupalExtra(site: DrupalSite, rows: Row[], zotero: Map<string, ApiItem[]>, compared: Row[]): string {
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const vocab = new Map(site.concepts.map((c) => [c.word.toLowerCase(), c]));
  const used = count(quotes, (r) => r.tags.map((t) => t.toLowerCase()));
  const outsideVocab = used.filter(([t]) => !vocab.has(t));
  const keywordUse = new Set(site.works.flatMap((w) => w.keywords.map((k) => k.toLowerCase())));
  const unusedConcepts = site.concepts.filter((c) => !used.some(([t]) => t === c.word.toLowerCase()) && !keywordUse.has(c.word.toLowerCase()));

  // Each work with quotes, matched to Zotero items by loose title, then year when titles repeat.
  const index = new Map<string, { library: string; item: ApiItem }[]>();
  for (const [library, items] of zotero) {
    for (const item of items) {
      const k = normalizedTitle(item.data.title);
      if (k) index.set(k, [...(index.get(k) ?? []), { library, item }]);
    }
  }
  const quoted = site.works.filter((w) => quotes.some((r) => r.parent === `drupal:${w.nid}`));
  const matches = quoted.map((w) => {
    let hits = index.get(normalizedTitle(w.title)) ?? [];
    const sameYear = hits.filter((h) => w.year && (h.item.data.date ?? "").includes(w.year));
    if (hits.length > 1 && sameYear.length) hits = sameYear;
    return { work: w, libraries: [...new Set(hits.map((h) => h.library))] };
  });
  const unmatched = matches.filter((m) => !m.libraries.length);

  const zoteroKeys = new Map<string, Row>();
  for (const r of compared) if (r.parsed.kind === "quote") zoteroKeys.set(quoteKey(r.parsed.text), r);
  const drupalKeys = new Set(quotes.map((r) => quoteKey(r.parsed.text)));
  const inBoth = [...drupalKeys].filter((k) => zoteroKeys.has(k)).length;
  const zoteroOnly = [...zoteroKeys.keys()].filter((k) => !drupalKeys.has(k));

  return `
## The old site

- **Works:** ${site.works.length}; with notes: ${site.works.filter((w) => w.notes.trim()).length}; with quotes: ${quoted.length}.
- **Quotes module:** ${site.quotes.length} standalone quotes (rows \`drupal-quote:*\`).
- **Text outside the quote spans:** ${site.works.filter((w) => w.notes.includes('class="quote"') && splitQuotes(w.notes).outside).length} works (kept as the first quote's commentary; see notes.jsonl).

### Concept vocabulary

${site.concepts.length} concepts, ${site.concepts.filter((c) => c.definition).length} with a definition, ${site.concepts.filter((c) => c.altLabels.length).length} with alternative labels, ${site.concepts.filter((c) => c.closeMatch).length} linked to WordNet.

${table(count(site.relations, (r) => ({ B: "broader", N: "narrower", R: "related", I: "inverse" })[r.type] ?? r.type), site.relations.length, "Relation", "Pairs")}

- Concepts used on quotes: ${used.filter(([t]) => vocab.has(t)).length}; used only as work keywords or not at all: ${site.concepts.length - used.filter(([t]) => vocab.has(t)).length}; used nowhere: ${unusedConcepts.length}.
- Quote terms missing from the vocabulary: ${outsideVocab.length}${outsideVocab.length ? `: ${outsideVocab.slice(0, 40).map(([t, n]) => `\`${t}\` (${n})`).join(", ")}` : ""}.

### Matching works to Zotero

Works with quotes, matched by title (and year where titles repeat) against ${[...zotero].map(([l, items]) => `${l} (${items.length} items)`).join(", ")}:

${table(count(matches, (m) => (m.libraries.length ? m.libraries.join(" + ") : "no match")), matches.length, "Found in", "Works")}

${unmatched.length ? ["Unmatched examples:", "", ...unmatched.slice(0, 12).map((m) => `- \`${m.work.nid}\` ${m.work.title} (${m.work.year ?? "n.d."}; ${m.work.authors.slice(0, 2).join("; ") || "no author"})`)].join("\n") : ""}

### Overlap with Zotero notes

Compared with ${compared.length ? `the ${compared.length} notes in the Zotero surveys given by --compare` : "nothing (run the Zotero surveys first)"}, by the first 120 letters of each quote:

- In both: ${inBoth} of ${drupalKeys.size} distinct old-site quotes.
- Only in Zotero notes: ${zoteroOnly.length}${zoteroOnly.length ? `, e.g. ${zoteroOnly.slice(0, 4).map((k) => `\`${zoteroKeys.get(k)!.key}\``).join(", ")}` : ""}.
- Distinct quotes across both: about ${drupalKeys.size + zoteroOnly.length}.
`;
}

/** The text of a note that isn't a quote, so the report can show it. */
function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const { source, refresh, out, libraries, compare } = args();
  let rows: Row[];
  let extra = "";
  if (source === "zotero") {
    rows = await zoteroRows(out, refresh);
    applyOcr(rows);
  } else {
    const site = await cached(join(out, "cache", "drupal.json"), refresh, () => loadDrupal(drupalUrl()));
    rows = drupalRows(site);
    applyOcr(rows);
    const zotero = new Map<string, ApiItem[]>();
    for (const library of libraries ?? [zoteroConfig().library]) {
      const file = join(out, "cache", `zotero-${library.replace("/", "-")}.json`);
      zotero.set(library, await cached(file, refresh, () => clientFor(library).getAll("items/top", {}, progress(`Items in ${library}`))));
    }
    const compared = compare.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
    extra = drupalExtra(site, rows, zotero, compared);
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "notes.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(out, "report.md"), report(rows, source === "zotero" ? "Zotero notes" : "the old Drupal site", extra));
  const quotes = rows.filter((r) => r.parsed.kind === "quote");
  const grades = count(quotes, (r) => r.parsed.grade).map(([g, n]) => `${g} ${n}`).join(", ");
  process.stderr.write(`${rows.length} notes, ${quotes.length} quotes (${grades}). Report: ${join(out, "report.md")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
