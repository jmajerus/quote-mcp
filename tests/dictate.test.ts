import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CorpusClient } from "../src/capture.js";
import { chooseSttEngine, commandArgs, dictationStatus, MAX_AUDIO, pageFromOcr, pageNumber, readCapture, saveSpokenQuote, searchMirror, searchWorks, sttLanguage, transcribeAudio } from "../src/dictate.js";
import type { FiledItem, PrintBook } from "../src/isbn.js";
import { renderCaptureIsbn } from "../src/web.js";
import { ToolError } from "../src/common.js";
import type { DB } from "../src/db.js";
import { deleteQuote } from "../src/edits.js";
import { getQuote } from "../src/queries.js";
import { serveHttp } from "../src/server.js";
import { renderAdmin } from "../src/web.js";
import { makeStore } from "./fixture.js";

let db: DB;
const workId = () => db.prepare("SELECT id FROM works WHERE title LIKE 'Mobbing%'").pluck().get() as number;
const ffmpeg = () => {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
  return !run.error && run.status === 0;
};
const pocketsphinx = fs.existsSync("/usr/share/pocketsphinx/model/en-us/en-us.lm.bin");
const pdftoppm = () => {
  const run = spawnSync("pdftoppm", ["-v"], { stdio: "ignore" });
  return !run.error && run.status === 0;
};
const tesseract = () => {
  const run = spawnSync("tesseract", ["--version"], { stdio: "ignore" });
  return !run.error && run.status === 0 && fs.existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
};

/** A short silent wav ffmpeg will accept. */
function silenceWav(): Buffer {
  const rate = 16_000;
  const data = Buffer.alloc(rate * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

beforeEach(() => {
  db = makeStore();
});

describe("finding the book", () => {
  it("matches a title, an author, and a citekey", () => {
    expect(searchWorks(db, "nobody filed").map((w) => w.title)).toEqual(["A Book Nobody Filed"]);
    expect(searchWorks(db, "Doe").map((w) => w.title)).toEqual(["A Book Nobody Filed"]);
    expect(searchWorks(db, "davenport1999mobbing").map((w) => w.title)).toEqual([expect.stringMatching(/mobbing/i)]);
    expect(searchWorks(db, "  ")).toEqual([]);
  });
});

describe("a spoken quote", () => {
  const say = (fields: Partial<{ text: string; page: string; tag: string; request_id: string }> = {}) =>
    saveSpokenQuote(db, {
      work: `quote:${workId()}`, text: fields.text ?? "A spoken line about dignity at work.", page: fields.page ?? "40",
      tag: fields.tag ?? "dignity", request_id: fields.request_id,
    }, "lan", { corpus: { verify() { throw new Error("a spoken quote is not checked against a book"); } } as unknown as CorpusClient });

  it("saves it transcribed on the chosen book, with the page and the concept, and doesn't ask corpus-mcp", async () => {
    const saved = await say();
    expect(saved.saved).toBe(true);
    expect(saved.unresolved).toEqual([]);
    expect(getQuote(db, saved.id)).toMatchObject({ text: "A spoken line about dignity at work.", locator: "p. 40", status: "transcribed", work: { id: workId() } });
    expect(db.prepare("SELECT kind FROM quote_origins WHERE quote_id = ?").pluck().get(saved.id)).toBe("capture");
    expect(db.prepare("SELECT tag, origin FROM quote_tags WHERE quote_id = ?").get(saved.id)).toEqual({ tag: "dignity", origin: "capture" });
    expect(db.prepare("SELECT actor, reason FROM history WHERE quote_id = ? AND kind = 'added'").get(saved.id)).toMatchObject({ actor: "lan", reason: expect.stringContaining("capture:") });
    const dropped: number[] = [];
    const result = await deleteQuote(db, { dropAnchor: async (id: number) => void dropped.push(id) } as unknown as CorpusClient, saved.id, "misheard", "lan");
    expect(dropped).toEqual([]);
    expect(result).toMatchObject({ deleted: saved.id, anchor_dropped: false });
    expect(db.prepare("SELECT id FROM quotes WHERE id = ?").get(saved.id)).toBeUndefined();
  });

  it("keeps a tag that isn't a concept, accepts a range and an alternative label, and a retry returns the same quote", async () => {
    const unknown = await say({ tag: "not a concept", page: "211 – 212" });
    expect(getQuote(db, unknown.id).locator).toBe("pp. 211-212");
    expect(unknown.unresolved).toEqual(["not a concept"]);
    const alt = await say({ text: "Another line, about the group.", tag: "group bullying", request_id: "once" });
    expect(alt.unresolved).toEqual([]);
    expect(db.prepare("SELECT concept_id IS NOT NULL FROM quote_tags WHERE quote_id = ?").pluck().get(alt.id)).toBe(1);
    const again = await say({ text: "Different words.", tag: "dignity", request_id: "once" });
    expect(again).toMatchObject({ id: alt.id, saved: false });
  });

  it("refuses a missing quote, a page that isn't one, and no concept", async () => {
    await expect(say({ text: "  " })).rejects.toThrow(/no text/);
    await expect(say({ page: "p. 12" })).rejects.toThrow(ToolError);
    await expect(say({ page: "0" })).rejects.toThrow(/page/);
    await expect(say({ page: "12-4" })).rejects.toThrow(/page/);
    await expect(say({ tag: " , " })).rejects.toThrow(/concept/);
    expect(pageNumber("040")).toBe("40");
  });
});

describe("the capture page", () => {
  it("asks for the book, then for the microphone, the page, and the concept", () => {
    const search = renderAdmin(db, "/admin/capture", new URLSearchParams({ q: '<script>' }))!;
    expect(search).toContain("Choose the book");
    expect(search).toContain('name="isbn"');
    expect(search).toContain("Look up");
    expect(search).not.toContain("<script>");
    expect(search).toContain("&lt;script&gt;");
    const found = renderAdmin(db, "/admin/capture", new URLSearchParams({ q: "Nobody" }))!;
    expect(found).toContain("A Book Nobody Filed");
    expect(found).toContain(`/admin/capture?work=`);
    const chosen = renderAdmin(db, "/admin/capture", new URLSearchParams({ work: String(workId()) }))!;
    expect(chosen).toContain('id="record"');
    expect(chosen).toContain("isSecureContext");
    expect(chosen).toContain("Needs a secure page");
    expect(chosen).toContain('id="scan"');
    expect(chosen).toContain('id="page-text"');
    expect(chosen).toContain(">Approve<");
    expect(chosen).toContain('name="page"');
    expect(chosen).toContain('name="tag"');
    expect(chosen).toContain('value="mobbing"');
    expect(chosen).toContain("Choose another book");
    expect(() => renderAdmin(db, "/admin/capture", new URLSearchParams({ work: "99999" }))).toThrow(/No work 99999/);
  });

  it("brings in a Zotero book that has no quotes, then opens the editor on it", async () => {
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES ('users/1', 'PRINT001', 1, 'book', NULL, 0, ?)").run(JSON.stringify({
      itemType: "book", title: "The Printed Workplace", date: "2014", creators: [{ creatorType: "author", lastName: "Binder", firstName: "Ada" }],
    }));
    expect(searchMirror(db, "Printed Workplace").map((b) => [b.title, b.authors[0], b.year])).toEqual([["The Printed Workplace", "Binder, Ada", "2014"]]);
    expect(searchMirror(db, "mobbing")).toEqual([]);
    const listed = renderAdmin(db, "/admin/capture", new URLSearchParams({ q: "Printed Workplace" }))!;
    expect(listed).toContain("In Zotero, no quotes yet");
    expect(listed).toContain('value="zotero:users/1/PRINT001"');
    expect(listed).toContain("Check Zotero");
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1", refreshZotero: async () => { throw new Error("not this path"); } } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = (fields: Record<string, string>) => fetch(`${base}/admin/capture`, {
      method: "POST", redirect: "manual", body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    });
    try {
      const brought = await post({ bring: "zotero:users/1/PRINT001", q: "Printed Workplace" });
      expect(brought.status).toBe(303);
      const location = brought.headers.get("location")!;
      const page = await (await fetch(`${base}${location}`)).text();
      expect(page).toContain("The Printed Workplace");
      expect(page).toContain('id="record"');
      expect(db.prepare("SELECT title FROM works WHERE zotero_key = 'PRINT001'").pluck().get()).toBe("The Printed Workplace");
      const again = await post({ bring: "zotero:users/1/PRINT001" });
      expect(again.headers.get("location")).toBe(location);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("shows a scanned ISBN for acceptance, and files it on Accept", async () => {
    const lookedUp: PrintBook = { isbn: "9780306406157", title: "A Printed Book", authors: ["Ada Binder"], year: "1999", publisher: "North Press", cover: "https://covers.example/m.jpg" };
    const shown = await renderCaptureIsbn(db, "978-0-306-40615-7", async () => lookedUp);
    expect(shown).toMatchObject({ status: 200 });
    if (!("html" in shown)) throw new Error("expected the review form");
    expect(shown.html).toContain("File this book");
    expect(shown.html).toContain("A Printed Book");
    expect(shown.html).toContain("Ada Binder");
    expect(shown.html).toContain("Reject");
    expect(shown.html).toContain("https://covers.example/m.jpg");
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES ('users/1', 'HAVE0001', 1, 'book', NULL, 0, ?)").run(JSON.stringify({
      itemType: "book", title: "A Printed Book", ISBN: "9780306406157",
    }));
    const already = await renderCaptureIsbn(db, "9780306406157", async () => { throw new Error("already in Zotero"); });
    expect(already).toMatchObject({ status: 200 });
    if (!("html" in already)) throw new Error("expected the Zotero book");
    expect(already.html).toContain("Already in Zotero");
    expect(already.html).toContain("zotero:users/1/HAVE0001");
    db.prepare("DELETE FROM zotero_items WHERE key = 'HAVE0001'").run();
    const missing = await renderCaptureIsbn(db, "9780306406157", async () => null);
    expect(missing).toMatchObject({ status: 404 });
    db.prepare("UPDATE works SET isbn = ? WHERE title LIKE 'Mobbing%'").run("9780306406157");
    const known = await renderCaptureIsbn(db, "9780306406157", async () => { throw new Error("already filed"); });
    expect(known).toEqual({ redirect: `/admin/capture?work=${workId()}` });
    db.prepare("UPDATE works SET isbn = NULL WHERE title LIKE 'Mobbing%'").run();

    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: {
      writer: () => db, corpus: null, primary: "users/1",
      lookupIsbn: async () => lookedUp,
      filePrintBook: async (book): Promise<FiledItem> => ({
        library: "users/1", key: "NEWB0001", version: 3,
        data: { itemType: "book", title: book.title, creators: [{ creatorType: "author", firstName: "Ada", lastName: "Binder" }], date: book.year ?? undefined, ISBN: book.isbn, publisher: book.publisher ?? undefined },
      }),
    } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const review = await fetch(`${base}/admin/capture?isbn=9780306406157`);
      expect(review.status).toBe(200);
      expect(await review.text()).toContain('name="file"');
      const accepted = await fetch(`${base}/admin/capture`, {
        method: "POST", redirect: "manual",
        body: new URLSearchParams({ file: "1", write_token: "a".repeat(32), isbn: "9780306406157", title: "A Printed Book", authors: "Binder, Ada", year: "1999", publisher: "North Press" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      });
      expect(accepted.status).toBe(303);
      const page = await (await fetch(`${base}${accepted.headers.get("location")}`)).text();
      expect(page).toContain("A Printed Book");
      expect(page).toContain('id="record"');
      expect(db.prepare("SELECT title FROM works WHERE zotero_key = 'NEWB0001'").pluck().get()).toBe("A Printed Book");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("checks Zotero for a book filed since the last import", async () => {
    let checks = 0;
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1", refreshZotero: async () => {
      checks++;
      db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES ('users/1', 'LATER001', 1, 'book', NULL, 0, ?)").run(JSON.stringify({ itemType: "book", title: "The Later Book", date: "2020" }));
    } } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const checked = await fetch(`${base}/admin/capture`, {
        method: "POST", redirect: "manual", body: new URLSearchParams({ refresh: "1", q: "Later Book" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      });
      expect(checks).toBe(1);
      expect(checked.status).toBe(303);
      expect(checked.headers.get("location")).toContain("q=Later+Book");
      const page = await (await fetch(`${base}${checked.headers.get("location")}`)).text();
      expect(page).toContain("The Later Book");
      expect(page).toContain("In Zotero, no quotes yet");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("saves a quote from the form and stays on the book", async () => {
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = (origin: string | null, fields: Record<string, string>) => fetch(`${base}/admin/capture`, {
      method: "POST", redirect: "manual", body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    });
    const fields = { work: `quote:${workId()}`, text: "Spoken from the page.", page: "63", tag: "mobbing", request_id: "form-1" };
    try {
      expect((await post("https://evil.example", fields)).status).toBe(403);
      const missing = await post(base, { ...fields, page: "" });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toContain("Spoken from the page.");
      const saved = await post(base, fields);
      expect(saved.status).toBe(303);
      const location = saved.headers.get("location")!;
      expect(location).toContain(`work=${workId()}`);
      const again = await (await fetch(`${base}${location}`)).text();
      expect(again).toContain("Saved:");
      expect(again).toContain("quote ");
      expect(again).toContain("<cite>Mobbing:");
      const repeat = await post(base, fields);
      expect(repeat.headers.get("location")).toContain("again=1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("transcription", () => {
  it("splits a transcribe command around the wav", () => {
    expect(commandArgs("whisper-cli -nt -f {wav}", "/tmp/a.wav")).toEqual(["whisper-cli", "-nt", "-f", "/tmp/a.wav"]);
    expect(commandArgs("printf %s 'Spoken from the book.'", "/tmp/a.wav")).toEqual(["printf", "%s", "Spoken from the book.", "/tmp/a.wav"]);
    expect(commandArgs("tesseract {image} stdout -l eng", "/tmp/page.png")).toEqual(["tesseract", "/tmp/page.png", "stdout", "-l", "eng"]);
  });

  it("returns the words, and says when none came through", async () => {
    const heard = await transcribeAudio(Buffer.from("audio"), "audio/webm", { convert: async () => Buffer.from("wav"), recognize: async () => "  hello   there " });
    expect(heard).toBe("hello there");
    await expect(transcribeAudio(Buffer.alloc(0), "audio/wav")).rejects.toThrow(/empty/);
    await expect(transcribeAudio(Buffer.alloc(1), "audio/wav", { convert: async () => Buffer.from("wav"), recognize: async () => "  " })).rejects.toThrow(/No words/);
  });

  it("sends the recording to the faster-whisper server", async () => {
    let posted = "";
    const whisper = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/audio/transcriptions") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        posted = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "Mobbing is an emotional assault." }));
      });
    });
    await new Promise<void>((resolve) => whisper.listen(0, "127.0.0.1", () => resolve()));
    const { port } = whisper.address() as import("node:net").AddressInfo;
    try {
      const text = await transcribeAudio(Buffer.from("audio"), "audio/webm", {
        convert: async () => Buffer.from("RIFFwav"),
        env: { QUOTE_WHISPER_URL: `http://127.0.0.1:${port}/`, QUOTE_HA_URL: "http://127.0.0.1:1", QUOTE_HA_TOKEN: "unused" },
      });
      expect(text).toBe("Mobbing is an emotional assault.");
      expect(posted).toBe("RIFFwav");
      expect(dictationStatus({ QUOTE_WHISPER_URL: "http://whisper.localdomain:8000" }).note).toContain("whisper.localdomain:8000");
    } finally {
      await new Promise<void>((resolve) => whisper.close(() => resolve()));
    }
  });

  it("picks Home Assistant Cloud, then the only engine, and matches its language", () => {
    expect(chooseSttEngine(["stt.faster_whisper", "stt.home_assistant_cloud"])).toBe("stt.home_assistant_cloud");
    expect(chooseSttEngine(["stt.faster_whisper"])).toBe("stt.faster_whisper");
    expect(chooseSttEngine(["stt.faster_whisper", "stt.openai"], "stt.openai")).toBe("stt.openai");
    expect(() => chooseSttEngine(["stt.a", "stt.b"])).toThrow(/QUOTE_HA_STT/);
    expect(sttLanguage("en", ["de-DE", "en-US"])).toBe("en-US");
    expect(sttLanguage("en-US", ["en-US"])).toBe("en-US");
    expect(() => sttLanguage("en", ["de-DE"])).toThrow(/QUOTE_HA_STT_LANGUAGE/);
  });

  it("sends the recording to Home Assistant's speech engine", async () => {
    let posted = "";
    let speech = "";
    const ha = http.createServer((req, res) => {
      const token = req.headers.authorization;
      if (token !== "Bearer secret-token") {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "GET" && req.url === "/api/states") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
          { entity_id: "light.kitchen" },
          { entity_id: "stt.faster_whisper" },
          { entity_id: "stt.home_assistant_cloud" },
        ]));
        return;
      }
      if (req.method === "GET" && req.url === "/api/stt/stt.home_assistant_cloud") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          languages: ["en-US", "de-DE"], formats: ["wav"], codecs: ["pcm"], sample_rates: [16000], bit_rates: [16], channels: [1],
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/stt/stt.home_assistant_cloud") {
        speech = String(req.headers["x-speech-content"] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          posted = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "Mobbing is an emotional assault.", result: "success" }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => ha.listen(0, "127.0.0.1", () => resolve()));
    const { port } = ha.address() as import("node:net").AddressInfo;
    try {
      const text = await transcribeAudio(Buffer.from("audio"), "audio/webm", {
        convert: async () => Buffer.from("RIFFwav"),
        env: { QUOTE_HA_URL: `http://127.0.0.1:${port}`, QUOTE_HA_TOKEN: "secret-token" },
      });
      expect(text).toBe("Mobbing is an emotional assault.");
      expect(posted).toBe("RIFFwav");
      expect(speech).toContain("language=en-US");
      expect(speech).toContain("sample_rate=16000");
      expect(dictationStatus({ QUOTE_HA_URL: "http://ha.local", QUOTE_HA_TOKEN: "t", QUOTE_HA_STT: "stt.home_assistant_cloud" }).note).toContain("stt.home_assistant_cloud");
    } finally {
      await new Promise<void>((resolve) => ha.close(() => resolve()));
    }
  });

  it("says when Home Assistant's engine fails, and a local command still wins", async () => {
    const ha = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: null, result: "error" }));
    });
    await new Promise<void>((resolve) => ha.listen(0, "127.0.0.1", () => resolve()));
    const { port } = ha.address() as import("node:net").AddressInfo;
    const env = { QUOTE_HA_URL: `http://127.0.0.1:${port}/`, QUOTE_HA_TOKEN: "secret-token", QUOTE_HA_STT: "stt.home_assistant_cloud" };
    try {
      await expect(transcribeAudio(Buffer.from("audio"), "audio/webm", { convert: async () => Buffer.from("RIFFwav"), env })).rejects.toThrow(/speech engine returned an error/);
      const text = await transcribeAudio(Buffer.from("audio"), "audio/webm", {
        convert: async () => Buffer.from("RIFFwav"),
        env: { ...env, QUOTE_TRANSCRIBE: "node -e \"process.stdout.write('Spoken from the book.')\" {wav}" },
      });
      expect(text).toBe("Spoken from the book.");
    } finally {
      await new Promise<void>((resolve) => ha.close(() => resolve()));
    }
  });

  it.skipIf(!ffmpeg())("runs QUOTE_TRANSCRIBE on the converted recording", async () => {
    const text = await transcribeAudio(silenceWav(), "audio/wav", { env: { QUOTE_TRANSCRIBE: "node -e \"process.stdout.write('Spoken from the book.')\" {wav}" } });
    expect(text).toBe("Spoken from the book.");
  });

  it.skipIf(!ffmpeg() || !pocketsphinx)("reads a synthesized quote with PocketSphinx", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-asr-"));
    const wav = path.join(dir, "quote.wav");
    try {
      const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "flite=text='Mobbing is an emotional assault.':voice=slt", "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" });
      expect(made.status).toBe(0);
      const text = await transcribeAudio(fs.readFileSync(wav), "audio/wav", { env: {} });
      expect(text.toLowerCase()).toContain("emotional assault");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ffmpeg())("transcribes a recording posted from the capture page", async () => {
    const previous = process.env.QUOTE_TRANSCRIBE;
    process.env.QUOTE_TRANSCRIBE = "node -e \"process.stdout.write('Spoken from the book.')\" {wav}";
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = (origin: string | null, audio: Buffer, type: string) => fetch(`${base}/admin/capture/transcribe`, {
      method: "POST", body: new Uint8Array(audio), headers: { "content-type": type, ...(origin ? { origin } : {}) },
    });
    try {
      expect((await post(null, silenceWav(), "audio/wav")).status).toBe(403);
      expect((await post(base, silenceWav(), "text/plain")).status).toBe(415);
      const heard = await post(base, silenceWav(), "audio/wav");
      expect(heard.status).toBe(200);
      expect(await heard.json()).toEqual({ text: "Spoken from the book." });
      const tooLong = await post(base, Buffer.alloc(MAX_AUDIO + 1), "audio/wav");
      expect(tooLong.status).toBe(413);
      expect(await tooLong.json()).toEqual({ error: "That recording is too long. Speak one quote, then stop." });
    } finally {
      if (previous === undefined) delete process.env.QUOTE_TRANSCRIBE;
      else process.env.QUOTE_TRANSCRIBE = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("a scanned page", () => {
  it("takes the page number from the footer, then the header", () => {
    expect(pageFromOcr("The year 1999 is in the sentence.\n\n— 63 —")).toBe("63");
    expect(pageFromOcr("12\n\nThe quote mentions 7.\n\n63")).toBe("63");
    expect(pageFromOcr("A line.\n\n211-212")).toBe("211-212");
    expect(pageFromOcr("63\n\nMobbing is an emotional assault.")).toBe("63");
    expect(pageFromOcr("no number here")).toBeNull();
  });

  it("returns the page text and its number, and a recording as speech", async () => {
    const page = await readCapture(Buffer.from("png"), "image/png", { ocr: async () => "63\n\nMobbing is an emotional assault." });
    expect(page).toEqual({ kind: "page", text: "63\n\nMobbing is an emotional assault.", page: "63" });
    await expect(readCapture(Buffer.from("png"), "image/png", { ocr: async () => "  " })).rejects.toThrow(/No words were read/);
    const speech = await readCapture(Buffer.from("audio"), "audio/webm", { convert: async () => Buffer.from("wav"), recognize: async () => "spoken" });
    expect(speech).toEqual({ kind: "speech", text: "spoken", page: null });
    await expect(readCapture(Buffer.from("nope"), "text/plain")).rejects.toThrow(/recording or a page/);
  });

  it.skipIf(!ffmpeg() || !tesseract())("reads a generated page with Tesseract", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-ocr-"));
    const image = path.join(dir, "page.png");
    try {
      const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=800x1000", "-vf", "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='63':fontsize=36:fontcolor=black:x=(w-text_w)/2:y=40,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Mobbing is an emotional assault.':fontsize=28:fontcolor=black:x=40:y=200", "-frames:v", "1", image], { stdio: "ignore" });
      expect(made.status).toBe(0);
      const read = await readCapture(fs.readFileSync(image), "image/png", { env: {} });
      expect(read.kind).toBe("page");
      expect(read.page).toBe("63");
      expect(read.text.toLowerCase()).toContain("emotional assault");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a page posted to the capture editor", async () => {
    const previous = process.env.QUOTE_OCR;
    process.env.QUOTE_OCR = "node -e \"process.stdout.write('63\\n\\nMobbing is an emotional assault.')\" {image}";
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = (origin: string | null, body: Buffer, type: string) => fetch(`${base}/admin/capture/read`, {
      method: "POST", body: new Uint8Array(body), headers: { "content-type": type, ...(origin ? { origin } : {}) },
    });
    try {
      expect((await post(null, Buffer.from("png"), "image/png")).status).toBe(403);
      expect((await post(base, Buffer.from("png"), "text/plain")).status).toBe(415);
      const read = await post(base, Buffer.from("png"), "image/png");
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ kind: "page", text: "63\n\nMobbing is an emotional assault.", page: "63" });
      const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("quote-page-"));
      const pdf = await post(base, Buffer.from("%PDF-1.4\nnot a page"), "application/pdf");
      expect(pdf.status).toBe(422);
      const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("quote-page-"));
      expect(after).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.QUOTE_OCR;
      else process.env.QUOTE_OCR = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(!pdftoppm())("renders a PDF's first page before the OCR command", async () => {
    const previous = process.env.QUOTE_OCR;
    process.env.QUOTE_OCR = "node -e \"process.stdout.write(String(process.argv[1]).endsWith('.png') ? '63\\n\\nMobbing is an emotional assault.' : 'raw pdf')\"";
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const pdf = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 40 100 Td (63) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF
`);
    try {
      const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("quote-page-"));
      const read = await fetch(`${base}/admin/capture/read`, {
        method: "POST", body: new Uint8Array(pdf), headers: { "content-type": "application/pdf", origin: base },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ kind: "page", text: "63\n\nMobbing is an emotional assault.", page: "63" });
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("quote-page-"))).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.QUOTE_OCR;
      else process.env.QUOTE_OCR = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
