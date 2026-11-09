import type { DB } from "./db.js";
import { type BiblioRecord } from "./bibkeys.js";
import { fullTitle, normalizedTitle, yearOf } from "./text.js";

/**
 * A one-time fill of Zotero authors from the old Drupal catalogue. Better BibTeX builds a citekey from the
 * author, and an item with no author gets a key that starts from the title. This adds the catalogue's authors
 * where the item has none. It does not change a citekey: Better BibTeX refreshes that after the author is there.
 */

/** The Zotero collections named Business and Literature, as the local library has them. */
export const BUSINESS_AND_LITERATURE = ["EXHW7S26", "DT8RJMFT", "SY4BB7JB", "QFP6XQ28", "VC7TCPQZ"];

export interface Creator { creatorType: string; lastName?: string; firstName?: string; name?: string }
export interface MirrorItem {
  library: string; key: string; version: number; title: string; year: string | null; citekey: string | null;
  collections: string[]; creators: Creator[];
}
export interface AuthorFill { library: string; key: string; version: number; title: string; citekey: string | null; creators: Creator[] }
export interface AuthorGap { library: string; key: string; title: string; citekey: string | null; why: string }
export interface AuthorPlan { fills: AuthorFill[]; gaps: AuthorGap[] }

/** "Last, First" becomes Zotero's two name fields. A name with no comma stays one field, so an organization does too. */
export function creatorsFrom(authors: string[]): Creator[] {
  return authors.filter(Boolean).map((author) => {
    const comma = author.split(/,\s*/);
    if (comma.length >= 2 && comma[0] && comma[1]) return { creatorType: "author", lastName: comma[0], firstName: comma.slice(1).join(", ") };
    return { creatorType: "author", name: author };
  });
}

const named = (c: Creator) => Boolean((c.lastName || c.name || c.firstName || "").trim());

/** Catalogue rows that are this work: the same short title, and the same year when both have one. */
function authorLists(item: MirrorItem, catalogue: BiblioRecord[]): string[][] {
  const title = normalizedTitle(item.title);
  if (!title) return [];
  const whole = fullTitle(item.title);
  let hits = catalogue.filter((r) => r.authors.length && normalizedTitle(r.title) === title && (!item.year || !yearOf(r.year) || yearOf(r.year) === item.year));
  if (hits.length > 1) {
    const exact = hits.filter((r) => fullTitle(r.title) === whole);
    if (exact.length) hits = exact;
  }
  const lists = new Map<string, string[]>();
  for (const hit of hits) lists.set(hit.authors.join("\n"), hit.authors);
  return [...lists.values()];
}

/**
 * Authors to add on items in these collections that have no author. An editor stays. Two catalogue rows that
 * name different people are left for a person, and so is a title the catalogue doesn't have.
 */
export function authorFills(items: MirrorItem[], catalogue: BiblioRecord[], collections: readonly string[]): AuthorPlan {
  const wanted = new Set(collections);
  const fills: AuthorFill[] = [];
  const gaps: AuthorGap[] = [];
  for (const item of items) {
    if (!item.collections.some((c) => wanted.has(c))) continue;
    if (item.creators.some((c) => (c.creatorType ?? "author") === "author" && named(c))) continue;
    if (!item.title.trim()) continue;
    const lists = authorLists(item, catalogue);
    if (lists.length !== 1) {
      gaps.push({ library: item.library, key: item.key, title: item.title, citekey: item.citekey, why: lists.length ? "several author lists" : "no catalogue record" });
      continue;
    }
    const kept = item.creators.filter((c) => c.creatorType && c.creatorType !== "author" && named(c));
    fills.push({ library: item.library, key: item.key, version: item.version, title: item.title, citekey: item.citekey, creators: [...creatorsFrom(lists[0]), ...kept] });
  }
  return { fills, gaps };
}

/** Items in the mirror, notes and attachments left out. */
export function mirrorItems(db: DB): MirrorItem[] {
  const rows = db.prepare("SELECT library, key, version, data FROM zotero_items WHERE deleted = 0 AND item_type NOT IN ('note', 'attachment')").all() as { library: string; key: string; version: number; data: string }[];
  return rows.map((row) => {
    const data = JSON.parse(row.data) as { title?: string; date?: string; citationKey?: string; collections?: string[]; creators?: Creator[] };
    return {
      library: row.library, key: row.key, version: row.version, title: data.title ?? "", year: yearOf(data.date),
      citekey: data.citationKey ?? null, collections: data.collections ?? [], creators: data.creators ?? [],
    };
  });
}

const ZOTERO = "https://api.zotero.org";

/**
 * Writes the authors to Zotero. Each item is read again first, so an author added since the mirror was synced
 * is left as it is, and the write uses the version Zotero has now.
 */
export async function addAuthors(fills: AuthorFill[], apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ written: number; skipped: number; failed: { key: string; error: string }[] }> {
  const result = { written: 0, skipped: 0, failed: [] as { key: string; error: string }[] };
  const headers = { "Zotero-API-Version": "3", "Zotero-API-Key": apiKey, accept: "application/json" };
  for (const fill of fills) {
    const url = `${ZOTERO}/${fill.library}/items/${fill.key}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      result.failed.push({ key: fill.key, error: (error as Error).message });
      continue;
    }
    if (!response.ok) {
      result.failed.push({ key: fill.key, error: `Zotero answered ${response.status}` });
      continue;
    }
    const item = await response.json() as { version?: number; data?: { version?: number; creators?: Creator[] } };
    const live = item.data?.creators ?? [];
    if (live.some((c) => (c.creatorType ?? "author") === "author" && named(c))) {
      result.skipped++;
      continue;
    }
    const version = item.version ?? item.data?.version;
    if (!version) {
      result.failed.push({ key: fill.key, error: "Zotero didn't give the item's version" });
      continue;
    }
    const kept = live.filter((c) => c.creatorType && c.creatorType !== "author" && named(c));
    const authors = fill.creators.filter((c) => c.creatorType === "author");
    let written: Response;
    try {
      written = await fetchImpl(url, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json", "If-Unmodified-Since-Version": String(version) },
        body: JSON.stringify({ creators: [...authors, ...kept] }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      result.failed.push({ key: fill.key, error: (error as Error).message });
      continue;
    }
    if (written.status === 204 || written.ok) result.written++;
    else result.failed.push({ key: fill.key, error: written.status === 412 ? "the item changed since it was read" : `Zotero answered ${written.status}` });
  }
  return result;
}
