# Pandoc quote text: handoff to corpus-mcp

2026-11-06. This removes quote-mcp's copied punctuation-based line-break reflow.
Pandoc conversion belongs to corpus-mcp's EPUB extractor, where the source document
structure is available. quote-mcp does not invoke Pandoc on extracted plain text.

`cite_quote.quote` now returns the stored quote text unchanged. The reader endpoint,
`GET /api/corpus/quotes?book=...`, keeps `prose` for API compatibility, with exactly
the same value as `text`. Paragraphs, verse lines, lists, and indentation from
`POST /api/verify` survive capture and both output paths. Legacy, transcribed, and
orphaned quotes also retain their stored breaks; no fallback guesses paragraphs.
Editorial brackets, emphasis, and omissions remain part of the stored quote.

## Migration boundary

This code change does not rewrite existing quotes, re-extract books, or activate extraction
profiles. Deployment and validation are recorded below. Corpus-mcp's checked-in Pandoc workflow stages
profile 3 and pins the Pandoc version. That remains the extraction migration path.

`followAnchors` updates origin anchor metadata and flags, not `quotes.text`.
Consequently, consuming a Pandoc re-anchoring event alone does not convert an old
quote's text into Pandoc output. Do not treat this patch as proof of full migration
readiness. Existing quotes need a separately reviewed text migration against paired
snapshots, preserving user editorial marks and retaining old wording when orphaned.
Do not blindly substitute `anchor.text` for the stored quote: that would discard
those marks. New captures receive canonical text through verify already.

## Coordination status

The holdings-mcp session could read corpus-mcp's checked-in Pandoc extraction code
and migration brief but had no tool for messaging its separate active session.
This document records the consumer behavior and remaining migration boundary for
that session to review. No agreement with that session is implied.

## Deployed consumer validation

2026-11-06 America/Chicago (2026-11-07 05:54 UTC). Canonical-text handling is deployed
as `/opt/quote-mcp/releases/20261107-055331`. This release uses production commit
`5af3fb262dca7eb15e0c437a9c9e72bfa21b8d8a` plus only the canonical-text patch.
It excludes capture-page commit `314df16` and the working-tree Home Assistant changes.
The original checkout and its unrelated edits remain in place.

- Typecheck, build, and the isolated production-baseline suite pass: 363 tests.
- SHA-256 hashes of the four deployed changed modules match the tested local build.
- Deployed modules pass 40 assertions against an in-memory store: verified and
  transcribed quotes, orphan flags, editorial marks, paragraphs, verse, lists, code,
  and indentation survive capture, citation, and HTTP reader output by id and UUID.
- All five live book feeds match read-only store queries, with `prose === text` and
  matching citation text. Read-only calls through the actual deployed MCP endpoint
  also preserve text for quotes 828–832. No synthetic quotes were saved to production.
- Health reports 840 quotes, no pending replica rows, and terminology through 332.
  The schema remains version 5. Previous release `20261105-173201` remains available
  for rollback; this patch requires no database rollback.

Server evidence: `/var/lib/quote-mcp/validation/canonical-text-20261107.json`.
The deployment record identifies the production baseline and the scoped dirty patch;
its commit alone does not identify the canonical-text changes.

Corpus extraction has not been activated. Its metadata correction and final live-state
reconciliation remain separate cutover gates. This consumer validation does not
approve the four anchored EPUBs or a rewrite of existing quote text.

## Four anchored EPUBs: inspection rehearsal

Completed 2026-11-07 06:05 UTC. A new inspection pair was created from the existing
coordinated snapshots using the pinned run code, Pandoc 3.1.11.1 and adapter 3.
The live corpus and the existing 239-book candidate were not modified.

| Book | Quote | Outcome |
|---|---|---|
| `main:53` | 831 | Staged; anchor moves from location index 154 to 756. All 231 old locations become 2,674 Pandoc locations. |
| `main:581` | 829 | Staged; anchor moves from location index 21 to 126. All 75 old locations become 534 Pandoc locations. |
| `main:133` | 830 | Deferred unchanged: navigation target `OEBPS/section-0_1_b04906ce2c840324_36f6.xhtml` is outside the linear XHTML spine. |
| `main:570` | 832 | Deferred unchanged: a Pandoc conversion hit its two-minute invocation timeout. |

For both staged books, stored quote text, old anchor text, and new anchor text are
identical. These two quotes need **anchor metadata migration only**, without any
`quotes.text` rewrite. Source-file hashes, exact anchored slices, known-page passage
verification, and current anchor ownership match the snapshot. All four anchors
passed these checks against their retained or staged extraction. The stored text of
quote 832 differs from its retained anchor only in whitespace and was preserved.

The deployed quote-mcp `followAnchors` implementation consumed the two staged events
in an in-memory database, preserving stored text and updating feed anchors. A rotated
rollback log replayed the old locations correctly. A separate orphan/found sequence
also preserved quote 832's stored text. Corpus-mcp's actual `readerQuotes` implementation,
using a loopback rehearsal feed, suppresses stale locations, highlights migrated
locations, suppresses stale locations after rollback, and highlights replayed old
locations. This is an implementation/API rehearsal, not a browser visual test.

Known-page verification passes. An initial unhinted passage-verification probe failed;
this review does not establish unhinted whole-book discovery for these saved passages.
That limitation is retained in the private report rather than inferred away from
successful anchor-slice checks.

Evidence on `corpus-mcp.localdomain`:

`/var/lib/corpus-mcp/reextraction/20261106-pandoc-v3/anchored-review-20261107/`
contains the new database pair, `report.json` (staging), `consumer-review.json`
(validation), and a protected private payload. On `quote-mcp.localdomain`, replay
evidence is `/var/lib/quote-mcp/validation/anchored-consumer-rehearsal-20261107.json`.

All reports retain `promotionReady: false`. The two refusals remain deferred, all 305
live indexed EPUBs remain on profile 1, and no live anchors or quote texts were migrated.
Before activation: deploy the corpus metadata correction; reconcile live index, files,
and primary-data drift; explicitly select the accepted books while retaining refusals;
and perform the actual consumer-feed and rollback checks during cutover. The inspection
pair is based on the old snapshot and must not replace newer primary data.
