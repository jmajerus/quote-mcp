import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { pathSegment, queryString, queryValue } from "../src/urls.js";
import { renderAdmin } from "../src/web.js";
import { makeStore } from "./fixture.js";

let db: DB;
beforeEach(() => {
  db = makeStore();
});

describe("readable links", () => {
  it("keeps : and @ in a path, and : @ / , in a query, and encodes the rest", () => {
    expect(pathSegment("human-work:mobbing")).toBe("human-work:mobbing");
    expect(pathSegment("@a/b c")).toBe("@a%2Fb%20c");
    expect(queryValue("zotero:users/827407/RBW97RMA")).toBe("zotero:users/827407/RBW97RMA");
    expect(queryValue("main:53")).toBe("main:53");
    expect(queryValue("a b, c@d & e?f#g%h")).toBe("a+b,+c@d+%26+e%3Ff%23g%25h");
    expect(queryString({ work: "zotero:users/1/MOBB0001", tag: "", offset: 0 }, (v) => v === 0)).toBe("?work=zotero:users/1/MOBB0001");
    expect(queryString({})).toBe("");
  });

  it("writes the admin pages' links readably, and answers them as it answers encoded ones", () => {
    const id = db.prepare("SELECT id FROM quotes WHERE kind = 'quote' ORDER BY id LIMIT 1").pluck().get() as number;
    db.prepare("INSERT INTO quote_tags (quote_id, tag, origin) VALUES (?, 'project:on-curiosity', 'agent')").run(id);
    const html = renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())!;
    expect(html).toContain('href="/admin/quotes?tag=project:on-curiosity"');
    const readable = renderAdmin(db, "/admin/quotes", new URLSearchParams("tag=project:on-curiosity"))!;
    expect(readable).toContain(`href="/admin/quotes/${id}"`);
    expect(readable).toBe(renderAdmin(db, "/admin/quotes", new URLSearchParams("tag=project%3Aon-curiosity")));
    const concept = renderAdmin(db, "/admin/concepts/human-work:mobbing", new URLSearchParams())!;
    expect(concept).toContain("<h1");
    expect(concept).toBe(renderAdmin(db, "/admin/concepts/human-work%3Amobbing", new URLSearchParams()));
  });
});
