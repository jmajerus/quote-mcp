# Quotes from scanned pages

**Status: proposed 2026-11-03, for review. Nothing is built yet. The first
step is a trial on a few real scans (below), which decides the export
settings and whether the agent saves quotes or proposes them.**

Most of the store's quotes are from paper books. The way they're marked is
already a capture method: a sticky tab on the page, and a vertical pencil
line in the margin beside the passage. This brief adds the missing step:
scan the tabbed pages, keep the images in Quote MCP, have an agent read the
marked passages into quotes, and check each quote against its image.

It's written for any scanner or camera that can write image or PDF files to
a folder: the CZUR Shine Ultra, Canon and Epson scanners and printers, a
phone. Quote MCP never talks to a device; it reads files.

## The flow

1. **Scan** the tabbed pages of one book. Only those pages: the tabs choose
   them.
2. **Deliver** the files to Quote MCP, into the book's folder on the scans
   share, or through an upload page. Either way, the batch names its work.
3. **Intake.** Quote MCP stores each page image, records it as waiting to
   be read, and lists it in a worklist.
4. **Read.** An agent (Claude, which reads images) takes a waiting page,
   finds the marked passages, reads the printed page number, and saves each
   passage with `add_quote`: status `transcribed`, linked to its page image,
   flagged `scan_unchecked`.
5. **Check.** A person opens the quote's admin page, which shows the page
   image beside the text, fixes anything with the edit form, and marks it
   checked, which clears the flag.

## Sources

Every source ends the same way: files in a folder, or files uploaded. What
differs is the software that writes them.

| Source | How files arrive | Settings that matter |
|---|---|---|
| CZUR Shine Ultra (desktop app, Windows or macOS, USB) | The app exports each batch to a folder; point it at the book's folder on the share | JPG per page, curve flattening on. Check that automatic cropping and finger removal don't trim the margin, which holds the pencil line. |
| Canon or Epson flatbed or printer | Their scan software saves to a folder, or the device scans to a network folder (SMB) itself | 300 dpi, colour or greyscale, JPG or PDF. Not black-and-white, whose threshold drops pencil. |
| Phone | The upload page, from the phone's browser through Access | The phone's document mode, flat and evenly lit |
| Anything else | Either of the above | The same: 300 dpi or better, greyscale or colour, margins kept |

Accepted files: JPG, PNG, TIFF, and PDF (each page of a PDF is a page
image; the server renders them with poppler's `pdftoppm`). HEIC from an
iPhone is converted on upload, or the phone is set to JPG.

Files are matched by content (sha256), so the same scan delivered twice is
one page, and a device that writes extra copies or retries doesn't
duplicate anything.

## Naming the work

A batch has to say which work its pages are from.

- **Share:** one folder per book under `scans/inbox/`, named by a key
  `add_quote` takes: a citekey (`nelson1994ways`), `zotero:users/<id>/<item key>`,
  or `quote:<id>` for a work not in Zotero yet (the "Works not in Zotero
  yet" worklist and holdings-mcp's `find_work` give these). A folder whose
  name isn't a known key waits, listed with the error, until it's renamed.
- **Upload page:** pick the work from a search box, then drop the files.

Once a batch is taken in, its files move out of the inbox, so the folder
can be reused for the next session with the same book.

## Storage

Images are files, not database rows: `/var/lib/quote-mcp/scans/<work
id>/<sha256>.<ext>`, kept as delivered, with a reduced copy (about 2,000
pixels on the long edge) made for reading and display. A tabbed page at 300
dpi is 1–3 MB, so a thousand pages is a few gigabytes.

- **Backups:** the nightly backup copies the store with SQLite's backup;
  the scans folder needs its own copy (rsync to the same place), since it's
  primary evidence for the quotes read from it.
- **Privacy:** page images are copyrighted pages and stay private. They're
  served only on the admin pages, behind Access, and never reach the public
  site or its snapshot.

Schema (a new version, applied by `migrate`):

- **`scan_batches`:** id, work, source (`share` or `upload`, and the folder
  or the person), received_at, page count.
- **`scan_pages`:** id, batch, file, sha256, width, height, the printed
  page number once read, status (`waiting`, `read`, `no_marks`, `unclear`),
  read_by, read_at, and a note (what the reader found).
- A quote read from a page gets an origin of kind `scan`, ref the page's
  id, whose raw keeps what the reader saw: where on the page the mark was,
  the lines it spans, and its confidence about the start and end.

## Reading the marks

The reader is an agent with a vision model, not plain OCR, because plain
OCR reads the whole page and ignores the marks. The conventions it's told:

- A **vertical line in the margin** marks the lines of text beside it. The
  quote is the sentences on those lines, widened to whole sentences where
  the line starts or ends mid-sentence. Nothing is quoted from outside the
  line's reach except to finish a sentence.
- A **bracket**, **underline**, or **margin note** marks a passage the same
  way; a margin note's words, if legible, become the quote's comment.
- A page can have **several marks**; each is its own quote.
- A mark that runs off the **bottom of a page** continues at the top of the
  next page in the same batch, and the two parts are one quote, with a page
  range (`211-212`).
- The **printed page number** comes from the header or footer. Where there
  isn't one, the reader says so and the quote has no locator (flag
  `no_locator`).
- A page with **no mark found** is `no_marks`, and one it can't read
  (blurred, cut off) is `unclear`. Both go to a person, not to a guess.
- It reads the **words as printed**: no modernised spelling, no corrected
  typos; `[sic]` isn't added.

MCP tools for the reader (registered beside `add_quote`):

- `scan_worklist(work?)`: pages waiting to be read, by book.
- `get_scan_page(id)`: the page image (MCP image content), its work, and
  the pages before and after in its batch, for marks that cross a page.
- `add_quote(…, scan_page, scan_pages?)`: as now, plus the page or pages
  read from, which sets the `scan` origin and the `scan_unchecked` flag.
- `set_scan_page(id, status, note?)`: `read` when its marks are saved, or
  `no_marks`, `unclear`.

## Checking

- The quote's admin page shows the page image beside the text, with the
  marked lines highlighted where the reader gave their place.
- A worklist, "Scanned quotes to check", holds quotes flagged
  `scan_unchecked`, by book, so a book's quotes can be checked in one
  sitting with the images.
- The edit form gains a **Checked against the scan** box, which clears the
  flag. The edit is recorded as usual.
- `no_marks` and `unclear` pages have their own worklist, where a person
  can draw the passage (later) or type it with the image in view.

## Decisions to make

1. **Save or propose.** Saved quotes (the default above) are checked after,
   with the image beside them, which is one click per quote. Proposals are
   accepted before they exist, which is the same check and an extra step.
   The trial shows how often the reader gets a passage's start and end
   right; if it's rarely wrong, saving is better.
2. **Keep the images after checking.** Proposed: yes. They're the evidence,
   and a later reader can find more in them.
3. **The share.** A Samba share on the Quote MCP server (`scans/inbox`,
   writable on the LAN only), or a folder on the scanning computer that a
   small sync copies across. The share is simpler for the network-folder
   scanners; the CZUR app writes to any folder the computer can see.

## The trial, before building

Scan two or three tabbed pages from a marked book on each device you'll
use, with the settings above, and put the files in a folder Claude can read.
The trial answers:

- whether the pencil line survives each device's processing (cropping,
  thresholding, compression);
- whether the reader finds each mark and its lines, and how often it gets
  the start and end right;
- whether the printed page number reads reliably;
- what resolution and format to standardise on.

## Phases

1. **Intake and viewing:** the schema, the share or upload, storage,
   backups, and the page images on the admin pages.
2. **Reading:** the MCP tools and the reader's instructions (a skill, like
   `cited-article`), run on demand over a book's waiting pages.
3. **Checking:** the image beside the quote, the worklists, and the
   Checked box.
