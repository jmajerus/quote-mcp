import { ToolError } from "./common.js";
import { workFromMirror } from "./capture.js";
import type { DB } from "./db.js";
import { yearOf } from "./text.js";
import type { ApiItem } from "./zotero.js";

/**
 * A print book's ISBN, looked up and shown for a person to accept. Accept files the book in Zotero.
 * The barcode reader types the number into the capture page; nothing is stored until Accept.
 */

export interface PrintBook {
  isbn: string;
  title: string;
  authors: string[];
  year: string | null;
  publisher: string | null;
  cover: string | null;
}

export interface FiledItem {
  library: string;
  key: string;
  version: number;
  data: ApiItem["data"];
}

const ZOTERO_ORG = "https://api.zotero.org";

/** The ISBN-13, or null when the text isn't a valid ISBN-10 or ISBN-13. */
export function canonicalIsbn(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[^0-9X]/g, "");
  const candidates = [compact, compact.slice(-13), compact.slice(-10)].filter((s) => s.length === 13 || s.length === 10);
  for (const candidate of candidates) {
    if (isbn13ok(candidate)) return candidate;
    if (isbn10ok(candidate)) return isbn10to13(candidate);
  }
  return null;
}

function isbn13ok(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function isbn10ok(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (value[i] === "X" ? 10 : Number(value[i])) * (10 - i);
  return sum % 11 === 0;
}

function isbn10to13(isbn10: string): string {
  const body = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

function isbn10from13(isbn13: string): string | null {
  if (!isbn13.startsWith("978")) return null;
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? "X" : String(check));
}

function digits(value: string): string {
  return value.toUpperCase().replace(/[^0-9X]/g, "");
}

/** True when the stored ISBN is this ISBN-13 or the ISBN-10 it came from. A field may hold several numbers. */
function holdsIsbn(stored: string | null | undefined, isbn13: string): boolean {
  const compact = digits(stored ?? "");
  const isbn10 = isbn10from13(isbn13);
  return compact.includes(isbn13) || (isbn10 !== null && compact.includes(isbn10));
}

/** A work or a mirror item already carrying this ISBN, so Accept doesn't file a second copy. */
export function filedIsbn(db: DB, isbn13: string): { workId: number } | { library: string; key: string; title: string } | null {
  const works = db.prepare("SELECT id, isbn, zotero_library, zotero_key FROM works WHERE isbn IS NOT NULL").all() as { id: number; isbn: string; zotero_library: string | null; zotero_key: string | null }[];
  const work = works.find((row) => holdsIsbn(row.isbn, isbn13));
  if (work) return { workId: work.id };
  const items = db.prepare(`SELECT library, key, data FROM zotero_items WHERE deleted = 0 AND parent_key IS NULL AND item_type NOT IN ('note', 'attachment', 'annotation')`).all() as { library: string; key: string; data: string }[];
  for (const item of items) {
    const data = JSON.parse(item.data) as ApiItem["data"];
    if (!holdsIsbn(data.ISBN, isbn13)) continue;
    const existing = db.prepare("SELECT id FROM works WHERE zotero_library = ? AND zotero_key = ?").pluck().get(item.library, item.key) as number | undefined;
    if (existing !== undefined) return { workId: existing };
    return { library: item.library, key: item.key, title: data.title ?? "(untitled)" };
  }
  return null;
}

interface LookedUp { title?: string; authors?: string[]; year?: string | null; publisher?: string | null; cover?: string | null }

async function readJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(String(response.status));
  }
  return response.json();
}

function coverUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.replace(/^http:\/\//, "https://"));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function openLibrary(isbn: string, fetchImpl: typeof fetch): Promise<LookedUp | null> {
  const body = await readJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, fetchImpl) as Record<string, { title?: string; authors?: { name?: string }[]; publishers?: { name?: string }[]; publish_date?: string; cover?: { medium?: string; large?: string } }>;
  const hit = body[`ISBN:${isbn}`];
  if (!hit?.title) return null;
  return {
    title: hit.title,
    authors: (hit.authors ?? []).map((author) => author.name?.trim() ?? "").filter(Boolean),
    year: yearOf(hit.publish_date),
    publisher: hit.publishers?.find((publisher) => publisher.name?.trim())?.name?.trim() ?? null,
    cover: coverUrl(hit.cover?.medium ?? hit.cover?.large),
  };
}

async function googleBooks(isbn: string, fetchImpl: typeof fetch): Promise<LookedUp | null> {
  const body = await readJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, fetchImpl) as { items?: { volumeInfo?: { title?: string; authors?: string[]; publisher?: string; publishedDate?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string } } }[] };
  const info = body.items?.[0]?.volumeInfo;
  if (!info?.title) return null;
  return {
    title: info.title,
    authors: (info.authors ?? []).map((author) => author.trim()).filter(Boolean),
    year: yearOf(info.publishedDate),
    publisher: info.publisher?.trim() || null,
    cover: coverUrl(info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail),
  };
}

/** Title, authors, year, and publisher for an ISBN. Open Library first, with Google Books filling gaps. */
export async function lookupIsbn(raw: string, fetchImpl: typeof fetch = fetch): Promise<PrintBook | null> {
  const isbn = canonicalIsbn(raw);
  if (!isbn) return null;
  const [library, google] = await Promise.all([
    openLibrary(isbn, fetchImpl).catch(() => null),
    googleBooks(isbn, fetchImpl).catch(() => null),
  ]);
  const title = library?.title || google?.title;
  if (!title) return null;
  return {
    isbn,
    title,
    authors: library?.authors?.length ? library.authors : (google?.authors ?? []),
    year: library?.year || google?.year || null,
    publisher: library?.publisher || google?.publisher || null,
    cover: library?.cover || google?.cover || null,
  };
}

/** The book the capture form is ready to file. A missing title, author, or ISBN is refused. */
export function printBookFromForm(form: URLSearchParams): PrintBook {
  const isbn = canonicalIsbn(form.get("isbn") ?? "");
  if (!isbn) throw new ToolError("That ISBN isn't valid.");
  const title = form.get("title")?.trim() ?? "";
  if (!title) throw new ToolError("The book needs a title.");
  if (title.length > 500) throw new ToolError("That title is too long.");
  const authors = (form.get("authors") ?? "").split("\n").map((author) => author.trim()).filter(Boolean);
  if (!authors.length) throw new ToolError("The book needs an author.");
  if (authors.length > 20 || authors.some((author) => author.length > 200)) throw new ToolError("Those authors don't look right.");
  const year = form.get("year")?.trim() ?? "";
  if (year && !/^\d{4}$/.test(year)) throw new ToolError("The year is a four-digit year, or empty.");
  const publisher = form.get("publisher")?.trim() || null;
  if (publisher && publisher.length > 200) throw new ToolError("That publisher is too long.");
  return { isbn, title, authors, year: year || null, publisher, cover: coverUrl(form.get("cover") ?? "") };
}

function zoteroCreators(authors: string[]): NonNullable<ApiItem["data"]["creators"]> {
  return authors.map((author) => {
    const comma = author.split(/,\s*/);
    if (comma.length >= 2 && comma[0] && comma[1]) return { creatorType: "author", lastName: comma[0], firstName: comma.slice(1).join(", ") };
    const parts = author.split(/\s+/);
    if (parts.length === 1) return { creatorType: "author", name: parts[0] };
    return { creatorType: "author", firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) ?? author };
  });
}

function bookData(book: PrintBook): ApiItem["data"] {
  return {
    itemType: "book",
    title: book.title,
    creators: zoteroCreators(book.authors),
    ...(book.year ? { date: book.year } : {}),
    ISBN: book.isbn,
    ...(book.publisher ? { publisher: book.publisher } : {}),
  };
}

function writeKey(env: NodeJS.ProcessEnv): { library: string; key: string } {
  const library = env.QUOTE_ZOTERO_LIBRARY?.trim() ?? "";
  const key = env.QUOTE_ZOTERO_WRITE_KEY?.trim() || env.QUOTE_ZOTERO_API_KEY?.trim() || "";
  if (!/^(users|groups)\/\d+$/.test(library) || !key) {
    throw new ToolError("Set QUOTE_ZOTERO_LIBRARY and QUOTE_ZOTERO_WRITE_KEY (a key that can create items) to file a print book.");
  }
  return { library, key };
}

async function zoteroJson(url: string, key: string, fetchImpl: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
      headers: { "Zotero-API-Version": "3", "Zotero-API-Key": key, accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new ToolError(`Zotero didn't answer: ${(error as Error).message}`);
  }
  if (response.status === 403) {
    await response.body?.cancel();
    throw new ToolError("The Zotero key can't create items. Set QUOTE_ZOTERO_WRITE_KEY to a key with write access.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new ToolError(`Zotero answered ${response.status}${detail ? `: ${detail}` : ""}.`);
  }
  return response.json();
}

/** Files the accepted book in Zotero, or returns the item already there for this ISBN. */
export async function filePrintBook(env: NodeJS.ProcessEnv, book: PrintBook, writeToken: string, fetchImpl: typeof fetch = fetch): Promise<FiledItem> {
  const { library, key } = writeKey(env);
  // A failed search must not become "nothing found": that would file a second copy of a book already in the library.
  const found = await zoteroJson(`${ZOTERO_ORG}/${library}/items?q=${book.isbn}&limit=25`, key, fetchImpl);
  if (!Array.isArray(found)) throw new ToolError("Zotero didn't list its items, so the book wasn't filed.");
  const existing = (found as { key: string; version: number; data?: ApiItem["data"] }[]).find((item) => holdsIsbn(item.data?.ISBN, book.isbn) && !item.data?.deleted);
  if (existing?.data) return { library, key: existing.key, version: existing.version, data: existing.data };
  const created = await zoteroJson(`${ZOTERO_ORG}/${library}/items`, key, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json", "Zotero-Write-Token": writeToken.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) },
    body: JSON.stringify([bookData(book)]),
  }) as { successful?: Record<string, { key?: string; version?: number }>; failed?: Record<string, { message?: string }> };
  const failure = Object.values(created.failed ?? {})[0]?.message;
  const item = created.successful?.["0"];
  if (!item?.key || failure) throw new ToolError(failure || "Zotero didn't file the book.");
  return { library, key: item.key, version: item.version ?? 0, data: bookData(book) };
}

/** Stores the filed item in the mirror and returns the work the quote editor opens on. */
export function rememberFiledItem(db: DB, item: FiledItem): number {
  db.prepare(`INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, ?, ?, NULL, 0, ?)
    ON CONFLICT (library, key) DO UPDATE SET version = excluded.version, item_type = excluded.item_type, deleted = 0, data = excluded.data`)
    .run(item.library, item.key, item.version, item.data.itemType || "book", JSON.stringify(item.data));
  return workFromMirror(db, `zotero:${item.library}/${item.key}`);
}
