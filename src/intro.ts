import fs from "node:fs";
import path from "node:path";
import { esc } from "./web.js";

/**
 * The public site's introductions, in a little Markdown: vocab/site.md for the whole site and
 * vocab/collections/<scheme>.md for each collection. They're read when a snapshot is built.
 */

export interface Intro { title: string; html: string; /** The first paragraph as plain text, for a card. */ summary: string | null }

/** Inline Markdown: links (web, mail, and site-relative only), **strong**, *emphasis*, and `code`. */
function inline(text: string): string {
  return esc(text)
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:|\/|#)[^)\s]*)\)/g, (_, label: string, href: string) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * The front page's introduction from a little Markdown: a `# Title` line, then paragraphs, `## headings`,
 * and `- lists`, separated by blank lines.
 */
export function readIntro(markdown: string): Intro {
  const lines = markdown.replace(/\r\n/g, "\n").trim().split("\n");
  const title = /^#\s+(.+)$/.exec(lines[0] ?? "")?.[1].trim();
  const blocks = (title ? lines.slice(1) : lines).join("\n").trim().split(/\n\s*\n/).filter(Boolean);
  const html = blocks.map((b) => {
    const heading = /^##\s+(.+)$/.exec(b);
    if (heading) return `<h2>${inline(heading[1])}</h2>`;
    const items = b.split("\n");
    if (items.every((l) => /^[-*]\s+/.test(l))) return `<ul>${items.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${inline(b.replace(/\n/g, " "))}</p>`;
  }).join("\n");
  const first = blocks.find((b) => !/^(##\s|[-*]\s)/.test(b));
  const summary = first?.replace(/\n/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "") ?? null;
  return { title: title ?? "Quotes", html, summary };
}

/** The introduction from a file, or a plain title when there isn't one. */
export function loadIntro(file: string): Intro {
  return fs.existsSync(file) ? readIntro(fs.readFileSync(file, "utf8")) : { title: "Quotes", html: "", summary: null };
}

/** The collections' introductions in a folder, one <scheme>.md each; none when there's no folder. */
export function loadCollections(dir: string): Record<string, Intro> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), readIntro(fs.readFileSync(path.join(dir, f), "utf8"))]));
}

