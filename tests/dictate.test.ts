import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CorpusClient } from "../src/capture.js";
import { commandArgs, pageFromOcr, pageNumber, readCapture, saveSpokenQuote, searchWorks, transcribeAudio } from "../src/dictate.js";
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
    await deleteQuote(db, null, saved.id, "misheard", "lan");
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
    expect(search).not.toContain("<script>");
    expect(search).toContain("&lt;script&gt;");
    const found = renderAdmin(db, "/admin/capture", new URLSearchParams({ q: "Nobody" }))!;
    expect(found).toContain("A Book Nobody Filed");
    expect(found).toContain(`/admin/capture?work=`);
    const chosen = renderAdmin(db, "/admin/capture", new URLSearchParams({ work: String(workId()) }))!;
    expect(chosen).toContain('id="record"');
    expect(chosen).toContain('id="scan"');
    expect(chosen).toContain('id="page-text"');
    expect(chosen).toContain(">Approve<");
    expect(chosen).toContain('name="page"');
    expect(chosen).toContain('name="tag"');
    expect(chosen).toContain('value="mobbing"');
    expect(chosen).toContain("Choose another book");
    expect(() => renderAdmin(db, "/admin/capture", new URLSearchParams({ work: "99999" }))).toThrow(/No work 99999/);
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
    } finally {
      if (previous === undefined) delete process.env.QUOTE_OCR;
      else process.env.QUOTE_OCR = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
