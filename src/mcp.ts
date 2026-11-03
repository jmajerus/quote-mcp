import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type AddQuoteOptions, MAX_QUOTE, addQuote } from "./capture.js";
import type { DB } from "./db.js";
import { QUEUES, ToolError, citeQuote, getConcept, getQuote, listConcepts, overview, searchQuotes, worklist } from "./queries.js";
import { type ConceptSet, listSets, setConcepts } from "./sets.js";

export const VERSION = "0.3.0";

const INSTRUCTIONS = `Search and cite a store of quotations from books, most of them paper books that exist only on the shelf, collected over years and tagged with concepts.
Concepts belong to named schemes; "human-work" (the human side of work) holds themes such as mobbing, false self, or psychic prison, with broader, narrower, related, and opposite concepts. Search by concept includes narrower concepts unless narrower=false. Concept sets name a part of a scheme (list_sets); search and list_concepts take set to stay within one.
Typical flow: search_quotes (words, a concept, an author, or a work) → get_quote for the full record → cite_quote for a CSL JSON item, a locator, and a Pandoc citation.
Beside quotes are notes: your own words at a page, or about a whole work, with no quoted text (kind "note"; the words are in note). Search finds both unless kind is given; cite_quote on a note gives the work and the place, not a quotation.
Words in a search are looked for in the quote's text and comment only, so a phrase search finds sources that use the phrase; to find quotes tagged with a concept, use concept (or tag).
A quote's status is "transcribed" (typed or OCR'd from the book, not checked against a text) or "unparsed" (not yet split from its note; left out of search by default). Flags such as ocr_suspect or no_locator say what to check before quoting. When a work has several editions in Zotero, cite_quote lists them under editions, each with its citekey; cite the one the page number belongs to.
To save a quote, use add_quote with a work key from holdings-mcp's find_work (or a citekey): when the work has a Calibre book, the words are checked against its text and saved as the book has them (status "verified"); with no match nothing is saved and the closest passages come back. A paper book's quote is saved "transcribed". corpus-mcp's save_quote is retiring: save new quotes here. Its few earlier quotes move here later.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Runs a tool body, turning ToolError into an isError result the agent can act on. */
function run(body: () => unknown): CallToolResult {
  try {
    return json(body());
  } catch (error) {
    if (error instanceof ToolError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

async function runAsync(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await body());
  } catch (error) {
    if (error instanceof ToolError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

/** What add_quote needs: a writable connection to the store (the server's own is read-only), and corpus-mcp. */
export interface Capture extends Omit<AddQuoteOptions, "actor"> { writer: () => DB }

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const quoteId = z.number().int().min(1).describe("Quote id from search_quotes");

export function createServer(db: DB, sets: ConceptSet[] = [], capture?: Capture): McpServer {
  const within = (set: string | undefined) => (set ? setConcepts(db, sets, set) : undefined);
  const server = new McpServer({ name: "quote-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool("search_quotes", {
    title: "Search quotes",
    description: "Search the quote store. Combine any of: words (full text over the quote's text and comment, not its tags; words are ANDed, \"quoted phrases\" kept together, a trailing * matches a prefix), a concept, a tag, an author, a work. Results are ranked when there are words, with matches in «» in the snippet. Each result comes with its kind (quote or note), work, locator, tags, and flags; a note's words are in note.",
    inputSchema: {
      query: z.string().optional().describe("Words or \"quoted phrases\" to find"),
      concept: z.string().optional().describe('A concept by name or slug ("job loss", "psychic-prison"); see list_concepts'),
      narrower: z.boolean().optional().describe("Include quotes tagged with narrower concepts (default true)"),
      set: z.string().optional().describe("A concept set's slug: only quotes tagged with one of its concepts; see list_sets"),
      tag: z.string().optional().describe("An exact tag, including tags that aren't concepts"),
      author: z.string().optional().describe("Part of an author's name, a chapter author, or an attribution"),
      work: z.string().optional().describe("Part of a work's title, its Zotero item key, its citekey, or a key from holdings-mcp's find_work (quote:<id> or zotero:<library>/<key>)"),
      flag: z.enum(["no_locator", "kindle_locator", "chapter_author", "unbalanced_quotes", "list_quote", "title_tag_only", "compound_tag", "commentary_mixed", "long", "ocr_suspect", "anchor_lost", "anchor_missing"]).optional(),
      status: z.enum(["transcribed", "verified", "unparsed", "any"]).optional().describe("Default: everything except unparsed"),
      kind: z.enum(["quote", "note", "any"]).optional().describe("Quotes, notes (your own words, no quoted text), or both (the default)"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      offset: z.number().int().min(0).optional(),
    },
    annotations: readOnly,
  }, ({ set, ...args }) => run(() => searchQuotes(db, { ...args, within: within(set) })));

  server.registerTool("get_quote", {
    title: "Get a quote",
    description: "One quote or note in full: text (a note's words are in note and comment), locator, work, tags with their concepts, keyword-in-context marks, comment, suspect words, where it came from (the old site, Zotero notes), and its history.",
    inputSchema: { id: quoteId },
    annotations: readOnly,
  }, ({ id }) => run(() => getQuote(db, id)));

  server.registerTool("cite_quote", {
    title: "Cite a quote",
    description: "The quote with a CSL JSON item for its work (from Zotero, or the old site's record when the work isn't in Zotero yet), the locator, the Better BibTeX citekey, and a Pandoc citation such as [@roberts1993victory, p. 44]. A quote checked against a Calibre book comes as prose (line breaks inside sentences joined, paragraph breaks as \\n\\n), with book (the Calibre book, its book_id for corpus-mcp's cite_passage) and position (section, for citing an EPUB by chapter, and page_label). Warnings say what to check: no page, possible OCR errors, a work not yet in Zotero.",
    inputSchema: { id: quoteId },
    annotations: readOnly,
  }, ({ id }) => run(() => citeQuote(db, id)));

  server.registerTool("list_concepts", {
    title: "List concepts",
    description: "The concepts quotes are tagged with, by scheme, with definitions, alternative labels, and how many quotes each has. Filter by words in the label, alternative labels, or definition.",
    inputSchema: {
      query: z.string().optional().describe("Words to look for"),
      scheme: z.string().optional().describe('A scheme slug, e.g. "human-work"'),
      set: z.string().optional().describe("Only the concepts in this concept set; see list_sets"),
    },
    annotations: readOnly,
  }, ({ set, ...args }) => run(() => listConcepts(db, { ...args, within: within(set) })));

  server.registerTool("list_sets", {
    title: "List concept sets",
    description: "Named concept sets: parts of a scheme picked for a map or a theme (despair and its neighbours, say), with how many concepts each has. Pass a set's slug as set to search_quotes or list_concepts.",
    inputSchema: {},
    annotations: readOnly,
  }, () => run(() => listSets(db, sets)));

  server.registerTool("get_concept", {
    title: "Get a concept",
    description: "One concept: definition, alternative labels, WordNet link, its broader, narrower, related, and opposite concepts, and how many quotes it has (with and without narrower concepts).",
    inputSchema: { concept: z.string().describe('Name, slug, or scheme:slug, e.g. "mobbing" or "human-work:false-self"') },
    annotations: readOnly,
  }, ({ concept }) => run(() => getConcept(db, concept)));

  server.registerTool("quote_worklist", {
    title: "Quote worklist",
    description: "What needs a person: unparsed quotes to split, works whose Zotero edition is ambiguous or that aren't in Zotero yet, tags that aren't concepts, and quotes by flag (no_locator, ocr_suspect, anchor_lost: a verified quote its Calibre book's new file no longer has, …). Call with no queue for the counts. terminology-mcp holds the concepts: to make an unresolved tag one, call its propose_term with scheme \"human-work\", a label, and evidence {quote: <id>, tag}, and leave the quote's tags alone.",
    inputSchema: {
      queue: z.enum(QUEUES).optional(),
      work: z.string().optional().describe("Limit a quote queue to one work (title, item key, or citekey)"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: readOnly,
  }, ({ queue, ...rest }) => run(() => (queue ? worklist(db, queue, rest) : overview(db))));

  if (capture) {
    server.registerTool("add_quote", {
      title: "Add a quote",
      description: `Save a quote from a work. When the work has a Calibre book with text, corpus-mcp checks the words against it first: on a match the quote is saved with the book's exact wording and page, status "verified"; with no match nothing is saved and the error lists the closest passages, so quote again from those. A work with no Calibre book (a paper book) is saved "transcribed", with the page you give. A retry with the same request_id, or the same words for the same work, returns the quote already saved. The answer carries book, the Calibre book it was checked against (null when it wasn't). Tags that aren't concepts are kept as written (see quote_worklist unresolved_tags).`,
      inputSchema: {
        work: z.string().describe("The work: a key from holdings-mcp's find_work (zotero:<library>/<key> or quote:<id>), a citekey, a Zotero item key, or a Calibre book id (main:42)"),
        text: z.string().max(MAX_QUOTE).describe("The words quoted, as in the book"),
        page: z.string().optional().describe('The page as printed ("211" or "211-212"); for a book with text, also where the check starts looking'),
        comment: z.string().optional().describe("Your note on the quote"),
        tags: z.array(z.string()).optional().describe('Concepts (by label or slug) or other tags, e.g. ["mobbing", "project:on-curiosity"]'),
        request_id: z.string().max(200).optional().describe("Any id unique to this quote, so a retry doesn't save it twice"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, (args) => runAsync(() => addQuote(capture.writer(), args, { corpus: capture.corpus, primary: capture.primary })));
  }

  return server;
}
