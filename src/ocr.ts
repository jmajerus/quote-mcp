import { readFileSync } from "node:fs";

/**
 * Finds words in a quote that look like OCR or typing errors, without a model. Only words that start
 * in lower case are checked, so names and other proper nouns pass. Real-word errors ("over die next
 * few years") need context and are left for a later pass.
 */

export interface Suspect {
  token: string;
  reason: "unknown" | "confusion" | "inner_capital" | "stray_apostrophe" | "repeated";
  /** A dictionary word one OCR confusion away, when there is one. */
  suggestion?: string;
}

/** Common OCR confusions, both ways round. */
const CONFUSIONS: [string, string][] = [
  ["rn", "m"], ["li", "h"], ["cl", "d"], ["e", "c"], ["f", "t"], ["i", "l"], ["u", "n"], ["o", "e"],
  ["ir", "u"], ["vv", "w"], ["ii", "n"], ["h", "b"], ["c", "o"], ["fi", "f"], ["E", "ff"],
];
/** Doubled words that are often right. */
const FINE_TWICE = new Set(["had", "that", "is", "very", "so", "far", "bye", "no", "yes", "do"]);

export function loadDictionary(path = process.env.QUOTE_DICTIONARY ?? "/usr/share/dict/words"): Set<string> {
  const words = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const w = line.trim();
    if (w && !w.endsWith("'s")) words.add(w.toLowerCase());
  }
  return words;
}

/** The word as the dictionary would list it: no possessive, no trailing apostrophe. */
function base(word: string): string {
  return word.toLowerCase().replace(/’/g, "'").replace(/'s$/, "").replace(/'$/, "");
}

function known(word: string, dict: Set<string>): boolean {
  const w = base(word);
  if (dict.has(w)) return true;
  // Hyphenated compounds and words the list only has in another inflection.
  if (w.includes("-")) return w.split("-").every((p) => !p || dict.has(p));
  return [w.replace(/s$/, ""), w.replace(/es$/, ""), w.replace(/ed$/, ""), w.replace(/ed$/, "e"), w.replace(/ing$/, ""), w.replace(/ing$/, "e"), w.replace(/ly$/, "")]
    .some((v) => v !== w && v.length > 2 && dict.has(v));
}

function confusion(word: string, dict: Set<string>): string | undefined {
  for (const [a, b] of CONFUSIONS) {
    for (const [from, to] of [[a, b], [b, a]]) {
      for (let i = word.indexOf(from); i >= 0; i = word.indexOf(from, i + 1)) {
        const fixed = word.slice(0, i) + to + word.slice(i + from.length);
        if (known(fixed, dict)) return fixed;
      }
    }
  }
  return undefined;
}

export function suspectTokens(text: string, dict: Set<string>): Suspect[] {
  const out: Suspect[] = [];
  const matches = [...text.matchAll(/[A-Za-z]+(?:[-’'][A-Za-z]+)*[’']?/g)];
  const tokens = matches.map((m) => m[0]);
  for (const [i, token] of tokens.entries()) {
    const prev = tokens[i - 1];
    if (prev && prev.toLowerCase() === token.toLowerCase() && !FINE_TWICE.has(token.toLowerCase())) {
      out.push({ token: `${prev} ${token}`, reason: "repeated" });
      continue;
    }
    if (!/^[a-z]/.test(token) || token.length < 3) continue;
    if (/[a-z][A-Z]/.test(token) && !/^[a-z]+$/.test(token)) {
      out.push({ token, reason: "inner_capital", suggestion: confusion(token, dict) });
      continue;
    }
    if (/[’']$/.test(token) && !/s[’']$/.test(token)) {
      // The closing mark of a single-quoted phrase ('life' and 'work') is not stray.
      const before = text.slice(Math.max(0, (matches[i].index ?? 0) - 200), matches[i].index);
      if (!/(?:^|[\s(“"—-])['‘][A-Za-z]/.test(before)) out.push({ token, reason: "stray_apostrophe" });
      continue;
    }
    if (known(token, dict)) continue;
    const suggestion = confusion(token.toLowerCase(), dict);
    out.push(suggestion ? { token, reason: "confusion", suggestion } : { token, reason: "unknown" });
  }
  return out;
}

/**
 * Drops "unknown" words that recur across many notes: a word used in several quotes is far more
 * likely a real word the list lacks (overqualified, workplace) than the same error made each time.
 */
export function dropCommonUnknowns(byNote: Map<string, Suspect[]>, minNotes = 3): Map<string, Suspect[]> {
  const notes = new Map<string, number>();
  for (const suspects of byNote.values()) {
    for (const t of new Set(suspects.filter((s) => s.reason === "unknown").map((s) => s.token.toLowerCase()))) notes.set(t, (notes.get(t) ?? 0) + 1);
  }
  const out = new Map<string, Suspect[]>();
  for (const [key, suspects] of byNote) {
    const kept = suspects.filter((s) => s.reason !== "unknown" || (notes.get(s.token.toLowerCase()) ?? 0) < minNotes);
    if (kept.length) out.set(key, kept);
  }
  return out;
}
