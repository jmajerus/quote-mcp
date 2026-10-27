import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DB } from "./db.js";
import { QUEUES, ToolError, citeQuote, getConcept, getQuote, listConcepts, overview, searchQuotes, worklist } from "./queries.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Search and cite a store of quotations from books, most of them paper books that exist only on the shelf, collected over years and tagged with concepts.
Concepts belong to named schemes; "human-work" (the human side of work) holds themes such as mobbing, false self, or psychic prison, with broader, narrower, related, and opposite concepts. Search by concept includes narrower concepts unless narrower=false.
Typical flow: search_quotes (words, a concept, an author, or a work) → get_quote for the full record → cite_quote for a CSL JSON item, a locator, and a Pandoc citation.
A quote's status is "transcribed" (typed or OCR'd from the book, not checked against a text) or "unparsed" (not yet split from its note; left out of search by default). Flags such as ocr_suspect or no_locator say what to check before quoting.`;

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

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const quoteId = z.number().int().min(1).describe("Quote id from search_quotes");

export function createServer(db: DB): McpServer {
  const server = new McpServer({ name: "quote-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool("search_quotes", {
    title: "Search quotes",
    description: "Search the quote store. Combine any of: words (full text over quote text, comments, and tags; words are ANDed, \"quoted phrases\" kept together, a trailing * matches a prefix), a concept, a tag, an author, a work. Results are ranked when there are words, with matches in «» in the snippet. Each quote comes with its work, locator, tags, and flags.",
    inputSchema: {
      query: z.string().optional().describe("Words or \"quoted phrases\" to find"),
      concept: z.string().optional().describe('A concept by name or slug ("job loss", "psychic-prison"); see list_concepts'),
      narrower: z.boolean().optional().describe("Include quotes tagged with narrower concepts (default true)"),
      tag: z.string().optional().describe("An exact tag, including tags that aren't concepts"),
      author: z.string().optional().describe("Part of an author's name, a chapter author, or an attribution"),
      work: z.string().optional().describe("Part of a work's title, its Zotero item key, or its citekey"),
      flag: z.enum(["no_locator", "kindle_locator", "chapter_author", "unbalanced_quotes", "list_quote", "title_tag_only", "compound_tag", "commentary_mixed", "long", "ocr_suspect"]).optional(),
      status: z.enum(["transcribed", "verified", "unparsed", "any"]).optional().describe("Default: everything except unparsed"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      offset: z.number().int().min(0).optional(),
    },
    annotations: readOnly,
  }, (args) => run(() => searchQuotes(db, args)));

  server.registerTool("get_quote", {
    title: "Get a quote",
    description: "One quote in full: text, locator, work, tags with their concepts, keyword-in-context marks, comment, suspect words, where it came from (the old site, Zotero notes), and its history.",
    inputSchema: { id: quoteId },
    annotations: readOnly,
  }, ({ id }) => run(() => getQuote(db, id)));

  server.registerTool("cite_quote", {
    title: "Cite a quote",
    description: "The quote with a CSL JSON item for its work (from Zotero, or the old site's record when the work isn't in Zotero yet), the locator, the Better BibTeX citekey, and a Pandoc citation such as [@roberts1993victory, p. 44]. Warnings say what to check: no page, possible OCR errors, a work not yet in Zotero.",
    inputSchema: { id: quoteId },
    annotations: readOnly,
  }, ({ id }) => run(() => citeQuote(db, id)));

  server.registerTool("list_concepts", {
    title: "List concepts",
    description: "The concepts quotes are tagged with, by scheme, with definitions, alternative labels, and how many quotes each has. Filter by words in the label, alternative labels, or definition.",
    inputSchema: {
      query: z.string().optional().describe("Words to look for"),
      scheme: z.string().optional().describe('A scheme slug, e.g. "human-work"'),
    },
    annotations: readOnly,
  }, (args) => run(() => listConcepts(db, args)));

  server.registerTool("get_concept", {
    title: "Get a concept",
    description: "One concept: definition, alternative labels, WordNet link, its broader, narrower, related, and opposite concepts, and how many quotes it has (with and without narrower concepts).",
    inputSchema: { concept: z.string().describe('Name, slug, or scheme:slug, e.g. "mobbing" or "human-work:false-self"') },
    annotations: readOnly,
  }, ({ concept }) => run(() => getConcept(db, concept)));

  server.registerTool("quote_worklist", {
    title: "Quote worklist",
    description: "What needs a person: unparsed quotes to split, works whose Zotero edition is ambiguous or that aren't in Zotero yet, tags that aren't concepts, and quotes by flag (no_locator, ocr_suspect, …). Call with no queue for the counts.",
    inputSchema: {
      queue: z.enum(QUEUES).optional(),
      work: z.string().optional().describe("Limit a quote queue to one work (title, item key, or citekey)"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: readOnly,
  }, ({ queue, ...rest }) => run(() => (queue ? worklist(db, queue, rest) : overview(db))));

  return server;
}
