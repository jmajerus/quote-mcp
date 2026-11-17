import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addQuote } from "../src/capture.js";
import type { DB } from "../src/db.js";
import { createServer } from "../src/mcp.js";
import { type Provenance, backfillProvenance, describeProvenance } from "../src/provenance.js";
import { getQuote, searchQuotes } from "../src/queries.js";
import { renderAdmin } from "../src/web.js";
import { makeStore } from "./fixture.js";

const WORK = "zotero:users/1/MOBB0001";
let db: DB;
const stampOf = (id: number) => getQuote(db, id).provenance as Provenance;
const savedId = (r: Record<string, unknown>) => (r.quote as { id: number }).id;

beforeEach(() => {
  db = makeStore();
  // The fixture seeds the old site's quotes straight into the store, after the migration's backfill.
  backfillProvenance(db);
});

describe("provenance stamps", () => {
  it("stamps a quote saved through add_quote as generative, with the person and the client the call presented", async () => {
    const r = await addQuote(db, { work: WORK, text: "A sentence an agent chose to keep." }, {
      corpus: null, primary: "users/1", caller: { by: "jo@example.org", client: { name: "claude-code", version: "2.1", user_agent: "Claude-User" } },
    });
    const p = stampOf(savedId(r));
    expect(p).toMatchObject({ v: 1, generative: true, channel: "mcp", by: "jo@example.org", client: { name: "claude-code", version: "2.1", user_agent: "Claude-User" }, detail: null });
    expect(p).not.toHaveProperty("inferred");
    expect(searchQuotes(db, { query: "agent chose" }).quotes[0].generative).toBe(true);
  });

  it("stamps an MCP call generative even when its client can't be named", async () => {
    const id = savedId(await addQuote(db, { work: WORK, text: "Saved by a client with no name." }, { corpus: null, primary: "users/1" }));
    expect(stampOf(id)).toMatchObject({ generative: true, channel: "mcp", by: null });
    expect(stampOf(id)).not.toHaveProperty("client");
  });

  it("stamps a quote from the capture page as a person's", async () => {
    const id = savedId(await addQuote(db, { work: WORK, text: "Read aloud from a paper book." }, { corpus: null, primary: "users/1", origin: "capture", actor: "jo@example.org" }));
    expect(stampOf(id)).toMatchObject({ generative: false, channel: "capture", by: "jo@example.org" });
  });

  it("carries corpus-mcp's record of whether an agent saved its quote", async () => {
    const source = { id: 5, source: "agent", created_by: "corpus-agent" };
    const id = savedId(await addQuote(db, { work: WORK, text: "One of corpus-mcp's own quotes.", request_id: "5" }, { corpus: null, primary: "users/1", origin: "corpus", source }));
    expect(stampOf(id)).toMatchObject({ generative: true, channel: "corpus-mcp", by: "corpus-agent" });
  });

  it("leaves a Zotero note's quote unknown, since nothing says who wrote the note", () => {
    const id = db.prepare("SELECT q.id FROM quotes q JOIN quote_origins o ON o.quote_id = q.id WHERE o.kind = 'zotero-note' LIMIT 1").pluck().get() as number;
    expect(stampOf(id)).toMatchObject({ generative: null, channel: "zotero" });
  });

  it("stamps quotes saved before stamps from their origins, marked inferred, and leaves stamped ones alone", async () => {
    const agent = savedId(await addQuote(db, { work: WORK, text: "Saved before there were stamps." }, { corpus: null, primary: "users/1", caller: { by: "jo@example.org" } }));
    const old = db.prepare("SELECT q.id FROM quotes q JOIN quote_origins o ON o.quote_id = q.id WHERE o.kind LIKE 'drupal%' LIMIT 1").pluck().get() as number;
    db.prepare("UPDATE quotes SET provenance = NULL WHERE id IN (?, ?)").run(agent, old);
    const before = JSON.stringify(db.prepare("SELECT id, provenance FROM quotes WHERE provenance IS NOT NULL ORDER BY id").all());
    expect(backfillProvenance(db)).toBe(2);
    expect(stampOf(agent)).toMatchObject({ generative: true, channel: "mcp", inferred: true });
    expect(stampOf(old)).toMatchObject({ generative: false, channel: "drupal", inferred: true });
    expect(JSON.stringify(db.prepare("SELECT id, provenance FROM quotes WHERE provenance IS NOT NULL AND id NOT IN (?, ?) ORDER BY id").all(agent, old))).toBe(before);
    expect(backfillProvenance(db)).toBe(0);
  });

  it("shows the stamp on the admin pages", async () => {
    const id = savedId(await addQuote(db, { work: WORK, text: "Shown with its maker." }, { corpus: null, primary: "users/1", caller: { by: "jo@example.org" } }));
    expect(renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())).toContain("Saved by a generative agent through quote-mcp&#39;s MCP tools · jo@example.org");
    expect(renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())).toContain(`<h1>Quote G${id}</h1>`);
    expect(renderAdmin(db, "/admin/quotes", new URLSearchParams())).toContain(`<a href="/admin/quotes/${id}" title="Saved by a generative agent">G${id}</a>`);
    const human = savedId(await addQuote(db, { work: WORK, text: "Spoken by a person." }, { corpus: null, primary: "users/1", origin: "capture", actor: "jo@example.org" }));
    expect(renderAdmin(db, "/admin/quotes", new URLSearchParams())).toContain(`<a href="/admin/quotes/${human}">#${human}</a>`);
    expect(getQuote(db, id).label).toBe(`G${id}`);
    expect(searchQuotes(db, { query: "spoken person" }).quotes[0].label).toBe(`#${human}`);
    expect(describeProvenance(null)).toBe("Not recorded");
  });

  it("takes the client's name from the MCP connection and the person from the request", async () => {
    const server = createServer(db, [], { writer: () => db, corpus: null, primary: "users/1" }, { by: "jo@example.org" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "some-agent", version: "0.9" });
    await client.connect(a);
    const result = await client.callTool({ name: "add_quote", arguments: { work: WORK, text: "Saved over a real MCP connection." } });
    const { quote } = JSON.parse((result.content as { text: string }[])[0].text) as { quote: { id: number } };
    expect(stampOf(quote.id)).toMatchObject({ generative: true, channel: "mcp", by: "jo@example.org", client: { name: "some-agent", version: "0.9" } });
    await client.close();
  });
});
