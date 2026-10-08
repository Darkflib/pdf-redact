# PDF Redactor

Redact PDFs in the browser. The text, image pixels and vector graphics under each redaction are **removed from the file**, not just covered, and the result is checked before you can download it. Your file is never uploaded anywhere.

Built on [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) (MuPDF compiled to WebAssembly), the same engine as PyMuPDF.

## What it does

1. **Find**: literal phrases (any case, tolerant of line breaks), regular expressions, and presets (email, UK phone, NI number, postcode, date). Every match is listed and can be unticked.
2. **Draw boxes**: for signatures, photos, scanned text and anything else search can't see.
3. **Redact**: MuPDF applies true redactions:
   - text whose glyphs fall in a box is deleted from the content stream
   - image pixels under a box are blanked (or the whole image removed)
   - vector graphics under a box are removed
4. **Clean up the document**: removes the Info dictionary, XMP metadata, attachments, bookmarks, comments, links, form fields, the accessibility structure tree (which holds `/Alt` and `/ActualText`), JavaScript and open actions, and named destinations. Each of these can be switched off.
5. **Rewrite**: the file is saved in full (`garbage=4,clean,sanitize`): no incremental-update history, unreferenced objects dropped, no encryption.
6. **Verify**: the output is reopened and re-searched for every pattern. It must have no extractable text inside any redacted area and none of the removed structures. If anything fails, the download is blocked until you explicitly accept it.

## Security model, and its limits

- **Nothing leaves the browser.** A Content-Security-Policy restricts scripts, the worker and fetches to this origin. MuPDF is served from this site, not a CDN, so the code that was tested is the code that runs.
  - Limitation: GitHub Pages can't set response headers, so the policy is set with a `<meta>` tag. That covers the page, but not the worker script, which runs without a policy of its own. The worker's code is in this repo.
- **Search only finds real text.** Scanned pages are images. Use drawn boxes for them, or OCR the file first.
- **Hidden layers** (optional content) are made visible by default, so what you review is everything in the file. With that switched off, hidden-layer text is neither found nor redacted. There is a test showing exactly that.
- **Text drawn as outlines** (vector paths) isn't text to a search. A drawn box removes it.
- **The checker is MuPDF checking MuPDF.** The test suite independently checks outputs with pdf.js, but in the browser the in-page check is MuPDF-only. For high-stakes material, also check the output with a different tool, e.g. `pdftotext out.pdf - | grep -i name`.
- **Raw-byte scan:** after redaction, literal terms are searched for in a decompressed copy of the file. A hit is shown as a warning, because short words can match font names.

## Development

```sh
npm ci
npm run test:unit   # node:test, 59 tests; outputs checked with pdf.js
npm run test:e2e    # builds dist/, Playwright + Chromium, 9 tests
npm run serve       # http://127.0.0.1:8080
```

If you already have a Chromium, set `CHROMIUM_PATH` instead of running `playwright install`.

Layout:

| Path | |
|---|---|
| `src/core.js` | All redaction logic. Pure functions; the MuPDF module is passed in, so tests and the worker run identical code |
| `src/worker.js` | Runs MuPDF in a module worker; also lets the UI kill a runaway regex |
| `src/app.js` | UI only |
| `tests/fixtures.mjs` | Builds test PDFs in code, each with a known leak planted in it |
| `tests/core.test.mjs` | Engine tests, including tests of the checker itself |
| `tests/app.spec.mjs` | Browser tests, including "no request leaves the origin" |

CI runs both suites on every push and pull request and deploys `dist/` to GitHub Pages from `main`. In the repo settings, set Pages → Source to **GitHub Actions**.

## Licence

AGPL-3.0-or-later, as required by MuPDF. See `LICENSE`. The deployed site links to this source.
