/** The pages' shared look and HTML escaping, for the admin pages and the public site; no Node dependencies. */

export const CSS = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #dedcd6;
  --accent: #2f5d8a; --chip: #eef2f7; --chip-text: #23405e; --warn: #a15c07; --warn-bg: #fdf1e0; --ok: #2e7d4f; --quote: #f2f0ea;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
    --accent: #7fb0e0; --chip: #233142; --chip-text: #cfe0f2; --warn: #e0a85a; --warn-bg: #3a2c18; --ok: #6cc290; --quote: #262522;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
  --accent: #7fb0e0; --chip: #233142; --chip-text: #cfe0f2; --warn: #e0a85a; --warn-bg: #3a2c18; --ok: #6cc290; --quote: #262522;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1100px; margin: 0 auto; padding: 10px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; }
.brand { font-weight: 700; }
.nav { display: flex; flex-wrap: wrap; gap: 2px; }
.nav a { color: var(--text); text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 0.92rem; }
.nav a[aria-current="page"] { background: var(--chip); color: var(--chip-text); font-weight: 600; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 64px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
h2 { font-size: 1.02rem; margin: 28px 0 10px; }
.sub, .note { color: var(--muted); font-size: 0.9rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.card .n { font-size: 1.6rem; font-weight: 650; }
.card .k { color: var(--muted); font-size: 0.85rem; }
form.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 18px; }
form.filters input, form.filters select { font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); min-width: 0; }
form.filters input[name="q"] { flex: 1 1 260px; }
form.edit label { display: block; margin: 14px 0 4px; font-weight: 600; }
form.edit input, form.edit textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
form.edit textarea { min-height: 7em; resize: vertical; }
form.edit textarea[readonly] { background: transparent; color: var(--muted); }
form.edit .actions { margin-top: 16px; display: flex; gap: 12px; align-items: center; }
.error { background: var(--warn-bg); color: var(--warn); border-radius: 6px; padding: 8px 12px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--surface); cursor: pointer; }
.result { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.result .text { margin: 0 0 6px; }
.meta { color: var(--muted); font-size: 0.87rem; }
blockquote { margin: 0 0 10px; padding: 12px 16px; background: var(--quote); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; white-space: pre-wrap; }
.chip { display: inline-block; background: var(--chip); color: var(--chip-text); border-radius: 999px; padding: 1px 9px; font-size: 0.82rem; margin: 2px 4px 2px 0; text-decoration: none; }
.kind { display: inline-block; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 0 6px; font-size: 0.78rem; margin-right: 4px; }
.words { margin: 0 0 10px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; white-space: pre-wrap; }
.chip.plain { background: transparent; border: 1px dashed var(--border); color: var(--muted); }
.flag { display: inline-block; background: var(--warn-bg); color: var(--warn); border-radius: 4px; padding: 0 6px; font-size: 0.78rem; margin-right: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 0.92rem; }
th { color: var(--muted); font-weight: 600; font-size: 0.82rem; }
.scroll { overflow-x: auto; }
pre { background: var(--quote); padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
mark { background: var(--warn-bg); color: inherit; }
.pager { display: flex; gap: 12px; margin-top: 14px; }
.isbn-review { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 12px; }
.isbn-review img { width: 9rem; background: var(--quote); border-radius: 8px; }
.isbn-review form { display: grid; gap: 6px; }
.isbn-review input, .isbn-review textarea { font: inherit; width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
.isbn-review .actions a { align-self: center; }
@media (max-width: 720px) { .isbn-review { grid-template-columns: 1fr; } .isbn-review img { width: 7rem; } }
form.bring { display: inline; }
form.bring button { background: none; border: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer; text-align: left; }
form.capture select { font: inherit; width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
.chosen { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.chosen:empty { display: none; }
.chosen button { background: var(--chip); color: var(--chip-text); border: none; border-radius: 999px; padding: 2px 10px; font-size: 0.82rem; cursor: pointer; }
form.capture label.file { display: inline-block; margin: 0; font-weight: 600; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); color: var(--accent); background: var(--surface); cursor: pointer; }
form.capture input#scan { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
button.recording { background: var(--warn); border-color: var(--warn); color: #1d1d1b; }
.live { min-height: 1.4em; }
.scan-view { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 12px; }
.scan-view[hidden] { display: none; }
.scan-view img { width: 100%; max-height: 28rem; object-fit: contain; background: var(--quote); border-radius: 8px; }
.page-text { margin: 0; max-height: 28rem; overflow: auto; white-space: pre-wrap; }
@media (max-width: 720px) { .scan-view { grid-template-columns: 1fr; } }
`;

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
