import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AddQuoteOptions, addQuote } from "./capture.js";
import { ToolError } from "./common.js";
import type { DB } from "./db.js";

/**
 * The capture page (/admin/capture): a book is chosen first, then each quote is spoken into a microphone
 * or read from a scanned page, corrected in the same editor, and saved with its page and a concept tag.
 * A recording is turned into 16 kHz mono wav by ffmpeg. QUOTE_TRANSCRIBE, when set, prints the transcript
 * of that wav; otherwise PocketSphinx's US English model does. A page image is read by QUOTE_OCR, or by
 * Tesseract, and the printed page number is taken from the header or footer.
 */

export const DEFAULT_MODEL = "/usr/share/pocketsphinx/model/en-us";
/** One quote, spoken, not a chapter: a few minutes of compressed audio. A scanned page is a photo or a PDF page. */
export const MAX_AUDIO = 8 * 1024 * 1024;
export const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_WAV = 16_000 * 2 * 180;

export class TranscribeError extends Error {}

export interface WorkHit {
  id: number; title: string; authors: string[]; year: string | null; isbn: string | null;
}

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Books matching a title, an author, an ISBN, a Zotero item key, or a citekey. */
export function searchWorks(db: DB, query: string, limit = 15): WorkHit[] {
  const q = query.trim();
  if (!q) return [];
  const rows = db.prepare(`
    SELECT w.id, w.title, w.authors, w.year, w.isbn
    FROM works w
    LEFT JOIN zotero_items z ON z.library = w.zotero_library AND z.key = w.zotero_key AND z.deleted = 0
    WHERE lower(w.title) LIKE @like ESCAPE '\\' OR lower(w.authors) LIKE @like ESCAPE '\\'
      OR lower(COALESCE(w.isbn, '')) LIKE @like ESCAPE '\\'
      OR w.zotero_key = @raw OR CAST(w.id AS TEXT) = @raw
      OR lower(COALESCE(json_extract(z.data, '$.citationKey'), '')) = @exact
      OR lower(COALESCE(json_extract(z.data, '$.extra'), '')) LIKE @cite ESCAPE '\\'
    ORDER BY w.title LIMIT @limit`).all({
    like: like(q), raw: q, exact: q.toLowerCase(), cite: like(`citation key: ${q}`), limit,
  }) as { id: number; title: string; authors: string; year: string | null; isbn: string | null }[];
  return rows.map((w) => ({ ...w, authors: JSON.parse(w.authors) as string[] }));
}

export function getWork(db: DB, id: number): WorkHit | undefined {
  const w = db.prepare("SELECT id, title, authors, year, isbn FROM works WHERE id = ?").get(id) as
    { id: number; title: string; authors: string; year: string | null; isbn: string | null } | undefined;
  return w && { ...w, authors: JSON.parse(w.authors) as string[] };
}

/** A page as printed: "40" or "211-212". The range runs forward. */
export function pageNumber(value: string): string {
  const m = /^\s*(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?\s*$/.exec(value);
  const start = m ? Number(m[1]) : 0;
  const end = m?.[2] !== undefined ? Number(m[2]) : undefined;
  if (!m || start < 1 || (end !== undefined && end < start)) throw new ToolError("The page is a number from the book, such as 40 or 211-212.");
  return end !== undefined ? `${start}-${end}` : String(start);
}

/** The concept tag for this quote. Commas separate more than one; a label may contain spaces. */
export function conceptTags(value: string): string[] {
  const tags = [...new Set(value.split(",").map((t) => t.trim()).filter(Boolean))];
  if (!tags.length) throw new ToolError("Give the quote a concept tag.");
  if (tags.some((t) => t.length > 80)) throw new ToolError("That concept tag is too long.");
  return tags;
}

export interface SpokenQuote {
  work: string; text: string; page: string; tag: string; request_id?: string;
}

/**
 * Saves one quote from the capture page, spoken or marked on a scan. The page and the concept tag are required.
 * A tag that isn't a concept yet is kept, and named in `unresolved`. A repeat of the same request, or the same
 * words, returns the quote already saved.
 */
export async function saveSpokenQuote(db: DB, spoken: SpokenQuote, actor: string, o: Omit<AddQuoteOptions, "origin" | "actor">): Promise<{ id: number; saved: boolean; unresolved: string[] }> {
  const text = spoken.text.trim();
  if (!text) throw new ToolError("The quote has no text. Record it, mark it on a scan, or type it.");
  const page = pageNumber(spoken.page);
  const tags = conceptTags(spoken.tag);
  const result = await addQuote(db, {
    work: spoken.work, text, page, tags, ...(spoken.request_id?.trim() ? { request_id: spoken.request_id.trim() } : {}),
  }, { ...o, origin: "capture", actor });
  const quote = result.quote as { id: number; tags: { tag: string; concept: string | null }[] };
  const unresolved = quote.tags.filter((t) => tags.some((tag) => tag.toLowerCase() === t.tag.toLowerCase()) && !t.concept).map((t) => t.tag);
  return { id: quote.id, saved: result.saved === true, unresolved };
}

export function modelDir(env: NodeJS.ProcessEnv): string {
  return env.QUOTE_POCKETSPHINX_MODEL?.trim() || DEFAULT_MODEL;
}

function modelReady(dir: string): boolean {
  return fs.existsSync(path.join(dir, "en-us")) && fs.existsSync(path.join(dir, "en-us.lm.bin")) && fs.existsSync(path.join(dir, "cmudict-en-us.dict"));
}

/** Whether the capture page can turn a recording into words, and what it would use. */
export function dictationStatus(env: NodeJS.ProcessEnv): { on: boolean; note: string } {
  const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
  if (ffmpeg.error || ffmpeg.status !== 0) return { on: false, note: "off without ffmpeg, which converts the recording" };
  if (env.QUOTE_TRANSCRIBE?.trim()) return { on: true, note: "QUOTE_TRANSCRIBE transcribes the recording" };
  const dir = modelDir(env);
  return modelReady(dir)
    ? { on: true, note: "PocketSphinx transcribes the recording" }
    : { on: false, note: `off until PocketSphinx's US English model is at ${dir}, or QUOTE_TRANSCRIBE is set` };
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(command: string, args: string[], limitMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** Words of a command, with quotes kept together. `{wav}` or `{image}` is the file; with neither, the path is the last argument. */
export function commandArgs(command: string, file: string): string[] {
  const args: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push((m[1] ?? m[2] ?? m[3] ?? "").replaceAll("{wav}", file).replaceAll("{image}", file));
  }
  if (!command.includes("{wav}") && !command.includes("{image}")) args.push(file);
  return args;
}

const extensionOf = (contentType: string) => {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "audio/webm") return ".webm";
  if (type === "audio/ogg") return ".ogg";
  if (type === "audio/wav" || type === "audio/wave" || type === "audio/x-wav") return ".wav";
  if (type === "audio/mpeg") return ".mp3";
  if (type === "audio/mp4" || type === "audio/m4a") return ".m4a";
  return ".bin";
};

async function ffmpegWav(audio: Buffer, contentType: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "quote-capture-"));
  const input = path.join(dir, `in${extensionOf(contentType)}`);
  const output = path.join(dir, "out.wav");
  try {
    await writeFile(input, audio);
    let result: RunResult;
    try {
      result = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TranscribeError("ffmpeg isn't installed, so the recording can't be transcribed. Type the quote instead.");
      throw error;
    }
    if (result.code !== 0) throw new TranscribeError("The recording couldn't be read. Try again, or type the quote.");
    const wav = await readFile(output);
    if (wav.length > MAX_WAV + 44) throw new TranscribeError("That recording is too long. Speak one quote, then stop.");
    return wav;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * PocketSphinx 5prealpha, called through ctypes because the package here is the library without its command.
 * The script is written beside the wav and removed with it. stdout is the hypothesis, lowercase.
 */
const POCKETSPHINX = String.raw`import ctypes, sys, wave

def main():
    model, wav_path = sys.argv[1], sys.argv[2]
    sb = ctypes.CDLL("libsphinxbase.so.3")
    ps = ctypes.CDLL("libpocketsphinx.so.3")
    sb.cmd_ln_parse_r.restype = ctypes.c_void_p
    sb.cmd_ln_parse_r.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_char_p), ctypes.c_int32]
    ps.ps_args.restype = ctypes.c_void_p
    ps.ps_init.restype = ctypes.c_void_p
    ps.ps_init.argtypes = [ctypes.c_void_p]
    ps.ps_start_utt.restype = ctypes.c_int
    ps.ps_start_utt.argtypes = [ctypes.c_void_p]
    ps.ps_process_raw.restype = ctypes.c_int
    ps.ps_process_raw.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int]
    ps.ps_end_utt.restype = ctypes.c_int
    ps.ps_end_utt.argtypes = [ctypes.c_void_p]
    ps.ps_get_hyp.restype = ctypes.c_char_p
    ps.ps_get_hyp.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    ps.ps_free.argtypes = [ctypes.c_void_p]
    args = [b"ps", b"-hmm", f"{model}/en-us".encode(), b"-lm", f"{model}/en-us.lm.bin".encode(),
            b"-dict", f"{model}/cmudict-en-us.dict".encode(), b"-logfn", b"/dev/null"]
    argv = (ctypes.c_char_p * len(args))(*args)
    cfg = sb.cmd_ln_parse_r(None, ps.ps_args(), len(args), argv, 1)
    if not cfg:
        sys.exit("PocketSphinx rejected its model configuration.")
    dec = ps.ps_init(cfg)
    if not dec:
        sys.exit("PocketSphinx couldn't load its US English model.")
    with wave.open(wav_path) as wav:
        pcm = wav.readframes(wav.getnframes())
    buf = ctypes.create_string_buffer(pcm, len(pcm))
    if ps.ps_start_utt(dec) < 0 or ps.ps_process_raw(dec, buf, len(pcm) // 2, 0, 0) < 0 or ps.ps_end_utt(dec) < 0:
        ps.ps_free(dec)
        sys.exit("PocketSphinx couldn't read the recording.")
    hyp = ps.ps_get_hyp(dec, None)
    ps.ps_free(dec)
    text = hyp.decode("utf-8", "replace") if hyp else ""
    print(" ".join(w for w in text.split() if not (w.startswith("<") and w.endswith(">"))))

if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        sys.exit("PocketSphinx isn't available (%s)." % error)
`;

async function recognizeWav(wav: Buffer, env: NodeJS.ProcessEnv): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "quote-capture-"));
  const file = path.join(dir, "quote.wav");
  try {
    await writeFile(file, wav);
    const command = env.QUOTE_TRANSCRIBE?.trim();
    if (command) {
      const args = commandArgs(command, file);
      let result: RunResult;
      try {
        result = await run(args[0]!, args.slice(1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TranscribeError(`${args[0]} from QUOTE_TRANSCRIBE wasn't found.`);
        throw error;
      }
      if (result.code !== 0) throw new TranscribeError(result.stderr.trim().split("\n").pop() || "The recording couldn't be transcribed.");
      return result.stdout;
    }
    const model = modelDir(env);
    if (!modelReady(model)) throw new TranscribeError(`PocketSphinx's US English model isn't at ${model}, and QUOTE_TRANSCRIBE isn't set. Type the quote, or set one of those up.`);
    const script = path.join(dir, "decode.py");
    await writeFile(script, POCKETSPHINX);
    let result: RunResult;
    try {
      result = await run("python3", [script, model, file]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TranscribeError("python3 isn't installed, so the recording can't be transcribed. Type the quote instead.");
      throw error;
    }
    if (result.code !== 0) throw new TranscribeError(result.stderr.trim().split("\n").pop() || "The recording couldn't be transcribed.");
    return result.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface TranscribeOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces ffmpeg, so a test can hand over a wav. */
  convert?: (audio: Buffer, contentType: string) => Promise<Buffer>;
  /** Replaces PocketSphinx or QUOTE_TRANSCRIBE. */
  recognize?: (wav: Buffer, env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Words heard in one recording. Empty audio, a huge one, and a silence all say what to do. */
export async function transcribeAudio(audio: Buffer, contentType: string, options: TranscribeOptions = {}): Promise<string> {
  if (!audio.length) throw new TranscribeError("The recording was empty.");
  if (audio.length > MAX_AUDIO) throw new TranscribeError("That recording is too long. Speak one quote, then stop.");
  const env = options.env ?? process.env;
  const wav = options.convert ? await options.convert(audio, contentType) : await ffmpegWav(audio, contentType);
  const text = (options.recognize ? await options.recognize(wav, env) : await recognizeWav(wav, env)).replace(/\s+/g, " ").trim();
  if (!text) throw new TranscribeError("No words came through. Move closer to the microphone, or type the quote.");
  return text;
}

const PAGE_LINE = /^(?:[-–—]\s*)?(?:page\s+|p\.\s*)?(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?(?:\s*[-–—])?$/i;

/**
 * The printed page number, when the scan shows one. A footer line that is only a number (or a range) wins,
 * then the same kind of line in the header. A number inside a sentence is the book's text, not the page.
 */
export function pageFromOcr(text: string): string | null {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const number = (line: string): string | null => {
    const match = PAGE_LINE.exec(line);
    if (!match) return null;
    const start = Number(match[1]);
    if (start < 1) return null;
    if (!match[2]) return String(start);
    const end = Number(match[2]);
    return end >= start ? `${start}-${end}` : null;
  };
  for (const line of lines.slice(-5).reverse()) {
    const found = number(line);
    if (found) return found;
  }
  for (const line of lines.slice(0, 5)) {
    const found = number(line);
    if (found) return found;
  }
  return null;
}

export interface CaptureRead {
  kind: "speech" | "page";
  text: string;
  page: string | null;
}

export interface ReadOptions extends TranscribeOptions {
  /** Replaces Tesseract or QUOTE_OCR. */
  ocr?: (image: Buffer, contentType: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

/** `speech` for a recording, `page` for a photo or a one-page PDF, or null when the body is neither. */
export function captureKind(contentType: string): "speech" | "page" | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("audio/") || type === "application/octet-stream") return "speech";
  if (type.startsWith("image/") || type === "application/pdf") return "page";
  return null;
}

function imageExtension(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/tiff") return ".tif";
  if (type === "application/pdf") return ".pdf";
  return ".img";
}

/** Tesseract, or QUOTE_OCR, prints the page. A PDF is its first page, rendered by pdftoppm. */
async function readPageFile(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  const command = env.QUOTE_OCR?.trim();
  if (command) {
    const args = commandArgs(command, file);
    const result = await run(args[0] ?? "", args.slice(1));
    if (result.code !== 0) throw new TranscribeError(result.stderr.trim().split("\n").pop() || "The page couldn't be read.");
    return result.stdout;
  }
  let image = file;
  let dir = "";
  if (file.endsWith(".pdf")) {
    dir = await mkdtemp(path.join(tmpdir(), "quote-page-"));
    const rendered = path.join(dir, "page.png");
    const result = await run("pdftoppm", ["-f", "1", "-l", "1", "-png", "-singlefile", file, path.join(dir, "page")]);
    if (result.code !== 0) throw new TranscribeError(result.stderr.trim().split("\n").pop() || "The PDF page couldn't be rendered.");
    image = rendered;
  }
  try {
    const result = await run("tesseract", [image, "stdout", "-l", "eng"], 120_000);
    if (result.code !== 0) throw new TranscribeError(result.stderr.trim().split("\n").pop() || "The page couldn't be read.");
    return result.stdout;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** Words on one scanned page, and the printed page number when the header or footer carries one. */
export async function ocrImage(image: Buffer, contentType: string, options: ReadOptions = {}): Promise<{ text: string; page: string | null }> {
  if (!image.length) throw new TranscribeError("The page image was empty.");
  if (image.length > MAX_IMAGE) throw new TranscribeError("That page image is too large. Photograph one page.");
  const env = options.env ?? process.env;
  let raw: string;
  if (options.ocr) raw = await options.ocr(image, contentType, env);
  else {
    const dir = await mkdtemp(path.join(tmpdir(), "quote-ocr-"));
    const file = path.join(dir, `page${imageExtension(contentType)}`);
    try {
      await writeFile(file, image);
      raw = await readPageFile(file, env);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TranscribeError("tesseract isn't installed, so the page can't be read. Type the quote instead.");
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new TranscribeError("No words were read from the page. Try a sharper picture, or type the quote.");
  return { text, page: pageFromOcr(text) };
}

/** One recording or one page, in the shape the capture editor fills. */
export async function readCapture(body: Buffer, contentType: string, options: ReadOptions = {}): Promise<CaptureRead> {
  const kind = captureKind(contentType);
  if (!kind) throw new TranscribeError("Send a recording or a page image.");
  if (kind === "speech") {
    const text = await transcribeAudio(body, contentType, options);
    return { kind, text, page: null };
  }
  const read = await ocrImage(body, contentType, options);
  return { kind, text: read.text, page: read.page };
}

/** Whether a page can be read here, for the settings page. */
export function ocrStatus(env: NodeJS.ProcessEnv): { on: boolean; note: string } {
  if (env.QUOTE_OCR?.trim()) return { on: true, note: "QUOTE_OCR reads the page" };
  const tesseract = spawnSync("tesseract", ["--version"], { stdio: "ignore" });
  if (!tesseract.error && tesseract.status === 0) return { on: true, note: "Tesseract reads the page" };
  return { on: false, note: "off until tesseract is installed, or QUOTE_OCR is set" };
}
