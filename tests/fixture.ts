import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { runImport } from "../src/import.js";

/**
 * A small store for the public site's tests: three concepts (mobbing narrower than abuse, dignity its
 * opposite), three quotes from two works (one in Zotero with a citekey, one not), and two margin notes on
 * the first work, one of them tagged private.
 */

const PRIMARY = "users/1";

export const drupal: DrupalSite = {
  concepts: [
    { kid: 1, word: "abuse", altLabels: [], definition: "cruel or inhumane treatment", closeMatch: null },
    { kid: 2, word: "mobbing", altLabels: ["group bullying"], definition: null, closeMatch: null },
    { kid: 3, word: "dignity", altLabels: [], definition: null, closeMatch: null },
  ],
  relations: [{ from: "abuse", to: "mobbing", type: "N" }, { from: "mobbing", to: "abuse", type: "B" }, { from: "abuse", to: "dignity", type: "I" }],
  works: [{
    nid: 7, title: "Mobbing: Emotional Abuse in the American Workplace", type: "Book", year: "1999", isbn: null, url: null, citekey: null, authors: ["Davenport, Noa"], keywords: [],
    notes: `<span class="quote" title="mobbing">\n"Mobbing is an emotional assault." (p. 40)\n</span>\n<span class="quote" title="abuse">\n"Abuse at work rarely announces itself." (p. 12)\n</span>`,
  }, {
    nid: 8, title: "A Book Nobody Filed", type: "Book", year: "2001", isbn: null, url: null, citekey: null, authors: ["Doe, Jane"], keywords: [],
    notes: `<span class="quote" title="dignity">\n"Everyone deserves dignity." \n</span>`,
  }],
  quotes: [],
};

export const QUOTED = ["Mobbing is an emotional assault", "Abuse at work rarely", "Everyone deserves dignity"];
export const SHARED_NOTE = "Compare Leymann";
export const PRIVATE_NOTE = "Too harsh on her";

export function makeStore(): DB {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'book', NULL, 0, ?)").run(PRIMARY, "MOBB0001", JSON.stringify({
    itemType: "book", title: "Mobbing: emotional abuse in the American workplace", date: "1999", extra: "Citation Key: davenport1999mobbing",
    creators: [{ creatorType: "author", lastName: "Davenport", firstName: "Noa" }],
  }));
  const note = (key: string, text: string, tags: string[]) => db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'note', 'MOBB0001', 0, ?)")
    .run(PRIMARY, key, JSON.stringify({ itemType: "note", parentItem: "MOBB0001", note: `<p>${text} (p. 41)</p>`, tags: tags.map((tag) => ({ tag })) }));
  note("MARGIN01", `${SHARED_NOTE}'s forty-five behaviours, which she leaves out.`, ["margin", "mobbing"]);
  note("MARGIN02", `${PRIVATE_NOTE}, I think, but she's right about the HR department.`, ["margin", "private", "mobbing"]);
  runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY] });
  return db;
}
