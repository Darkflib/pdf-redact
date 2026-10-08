# PDF Redactor

Redact PDFs in the browser. The text, image pixels and vector graphics under each redaction are **removed from the file**, not just covered, and the result is checked before you can download it. Your file is never uploaded anywhere.

Built on [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) (MuPDF compiled to WebAssembly), the same engine as PyMuPDF.

## What it does

1. **Find**: literal phrases, regular expressions, and presets (email, UK phone, NI number, postcode, date). Every match is listed and can be unticked. Phrase search is forgiving:
   - **Any case.**
   - **Between words:** any run of spaces, line breaks, dots, underscores or hyphens, or none at all. "John Smithers" also finds `johnsmithers.org`, `john.smithers@…`, `john_smithers` and a name wrapped over two lines.
   - **Within a word:** one optional space between letters, for letter-spaced text, which extracts as `J o h n`.
   - **"Show the text search can see"** displays each page's extracted text, so you can see why something wasn't matched.
2. **OCR (optional)**: for scanned pages. Pages with no text are flagged, and **Read scanned pages** runs [Tesseract](https://github.com/naptha/tesseract.js) in the browser, so search can find words in scans. The engine and English model (about 7 MB) are only downloaded if you use it, and come from this site, not a CDN. Matches found by OCR are redacted by blanking the scan's pixels. Because there's no text to search again afterwards, they're checked by confirming each region now renders as a flat fill.
3. **Draw boxes**: for signatures, photos and anything else search can't find. **Draw boxes** above the pages turns drawing on or off. It's off by default on touch screens so swiping scrolls.
4. **Redact**: MuPDF applies true redactions:
   - text whose glyphs fall in a box is deleted from the content stream
   - image pixels under a box are blanked (or the whole image removed)
   - vector graphics under a box are removed
5. **Clean up the document**: removes the Info dictionary, XMP metadata, attachments, bookmarks, comments, links, form fields, the accessibility structure tree (which holds `/Alt` and `/ActualText`), JavaScript and open actions, and named destinations. Each of these can be switched off.
6. **Rewrite**: the file is saved in full (`garbage=4,clean,sanitize`): no incremental-update history, unreferenced objects dropped, no encryption.
7. **Verify**: the output is reopened and re-searched for every pattern. It must have no extractable text inside any redacted area and none of the removed structures. If anything fails, the download is blocked until you explicitly accept it.

### Several files at once

Choose or drop several PDFs. The first opens for review, and the list lets you switch between them. **Redact all files** runs the same search on every file and redacts **every match without review**. Optionally it OCRs pages that have no text. The file you're reviewing keeps its own unticked matches, boxes and OCR results. Each file gets its own verification result and download link, and the files that pass are offered together as a .zip. Password-protected files are skipped, so open those on their own.

## Security model, and its limits

- **Nothing leaves the browser.** A Content-Security-Policy restricts scripts, the worker and fetches to this origin. MuPDF is served from this site, not a CDN, so the code that was tested is the code that runs.
  - Limitation: GitHub Pages can't set response headers, so the policy is set with a `<meta>` tag. That covers the page, but not the worker script, which runs without a policy of its own. The worker's code is in this repo.
- **OCR can misread.** A badly scanned name may be read as something else and missed. Low-confidence words are counted and reported. Review scans by eye, or cover them with drawn boxes.
- **Hidden layers** (optional content) are made visible by default, so what you review is everything in the file. With that switched off, hidden-layer text is neither found nor redacted. There is a test showing exactly that.
- **Text drawn as outlines** (vector paths) isn't text to a search. A drawn box removes it.
- **The checker is MuPDF checking MuPDF.** The test suite independently checks outputs with pdf.js, but in the browser the in-page check is MuPDF-only. For high-stakes material, also check the output with a different tool, e.g. `pdftotext out.pdf - | grep -i name`.
- **Raw-byte scan:** after redaction, literal terms are searched for in a decompressed copy of the file. A hit is shown as a warning, because short words can match font names.

## Development

```sh
npm ci
npm run test:unit   # node:test, 85 tests (incl. OCR); outputs checked with pdf.js
npm run test:e2e    # builds dist/, Playwright + Chromium, 16 tests
npm run serve       # http://127.0.0.1:8080
```

If you already have a Chromium, set `CHROMIUM_PATH` instead of running `playwright install`.

The icons and link-preview card are drawn from `assets/icon.svg` and `assets/og.html`. After changing either, run `node scripts/make-assets.mjs` to regenerate the PNGs in `src/`. `tests/meta.test.mjs` checks that the tags, absolute URLs and image sizes all match.

Layout:

| Path | |
|---|---|
| `src/core.js` | All redaction logic. Pure functions; the MuPDF module is passed in, so tests and the worker run identical code |
| `src/ocr.js` | Converts Tesseract output into the same text-and-position format as real text, so OCR results go through the same search |
| `src/ocr-engine.js` | Loads Tesseract only when needed, with every file served from this site |
| `src/worker.js` | Runs MuPDF in a module worker; also lets the UI kill a runaway regex |
| `src/app.js` | UI only |
| `tests/fixtures.mjs` | Builds test PDFs in code, each with a known leak planted in it |
| `tests/core.test.mjs` | Engine tests, including tests of the checker itself |
| `tests/ocr.test.mjs` | OCR tests; the final check runs OCR again on the *output* |
| `tests/app.spec.mjs` | Browser tests: OCR, batch, draw mode on touch screens, and "no request leaves the origin" |

CI runs both suites on every push and pull request and deploys `dist/` to GitHub Pages from `main`. In the repo settings, set Pages → Source to **GitHub Actions**.

## Licence

AGPL-3.0-or-later, as required by MuPDF. See `LICENSE`. The deployed site links to this source.
