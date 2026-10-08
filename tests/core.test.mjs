// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit/integration tests for src/core.js.
//
// Principle: MuPDF performs the redaction, so wherever possible the *output* is
// checked with an independent PDF engine (pdf.js) rather than by asking MuPDF
// whether MuPDF did its job.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as core from "../src/core.js";
import * as fx from "./fixtures.mjs";

// ------------------------------------------------------------------ helpers

/** Open with pdf.js (independent engine). */
async function pdfjsOpen(bytes, password) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes).slice(),
    password,
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
}

/** All extractable text, per pdf.js, joined with newlines. */
async function pdfjsText(bytes) {
  const doc = await pdfjsOpen(bytes);
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent({ includeMarkedContent: false });
    parts.push(tc.items.map((it) => it.str ?? "").join(" "));
  }
  await doc.loadingTask.destroy();
  return parts.join("\n");
}

/** Decompressed bytes as a lower-cased latin1 string, for raw greps. */
function rawText(bytes) {
  const d = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf").asPDF();
  const raw = d.saveToBuffer("decompress").asUint8Array();
  return Buffer.from(raw).toString("latin1").toLowerCase();
}

/** RGB at a page-space point, rendered at 1:1 with MuPDF. */
function pixelAt(bytes, pageIndex, [x, y]) {
  const d = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf");
  const pix = d.loadPage(pageIndex).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  const i = (Math.round(y) - pix.getY()) * pix.getStride() + (Math.round(x) - pix.getX()) * 3;
  return [px[i], px[i + 1], px[i + 2]];
}

const centre = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2];

/** Full pipeline: find patterns, redact them plus any boxes. */
function runRedaction(bytes, { terms = [], regexes = [], presets = [], boxes = [], options = {}, password } = {}) {
  const patterns = core.compilePatterns({ terms, regexes, presets }, options);
  const pdf = core.openPrepared(mupdf, bytes, { password, options });
  const matches = core.findMatches(pdf, patterns);
  return { matches, ...core.redact(mupdf, bytes, { matches, boxes, patterns, password, options }) };
}

// ------------------------------------------------------------------ patterns

describe("compilePatterns", () => {
  test("literal terms are escaped, case-insensitive by default", () => {
    const [p] = core.compilePatterns({ terms: ["a.b (c)"] });
    assert.ok(p.re.test("A.B (C)"));
    p.re.lastIndex = 0;
    assert.ok(!p.re.test("axb (c)"), "dot must be literal");
  });

  test("terms tolerate line breaks / repeated spaces between words", () => {
    const [p] = core.compilePatterns({ terms: ["John Smithers"] });
    assert.ok(p.re.test("John\nSmithers"));
    p.re.lastIndex = 0;
    assert.ok(p.re.test("John   Smithers"));
  });

  test("terms match with no separator, or dots/underscores/hyphens, between words", () => {
    const [p] = core.compilePatterns({ terms: ["Mike Preston"] });
    for (const sample of ["mikepreston.org", "mike.preston@example.com", "Mike_Preston", "mike-preston"]) {
      p.re.lastIndex = 0;
      assert.ok(p.re.test(sample), sample);
    }
  });

  test("terms match letter-spaced text", () => {
    const [p] = core.compilePatterns({ terms: ["Mobile"] });
    assert.ok(p.re.test("M o b i l e"));
  });

  test("caseSensitive option is honoured", () => {
    const [p] = core.compilePatterns({ terms: ["Smith"] }, { caseSensitive: true });
    assert.ok(!p.re.test("SMITH"));
  });

  test("blank entries are ignored", () => {
    assert.equal(core.compilePatterns({ terms: ["", "  "], regexes: [" "] }).length, 0);
  });

  test("invalid regex raises a named error", () => {
    assert.throws(() => core.compilePatterns({ regexes: ["(unclosed"] }), { code: "BAD_REGEX" });
  });

  test("unknown preset raises", () => {
    assert.throws(() => core.compilePatterns({ presets: ["nope"] }), { code: "BAD_PRESET" });
  });
});

describe("presets", () => {
  const cases = {
    email: { yes: ["a.b+c@example.co.uk", "x@y.io"], no: ["not an email", "a@b"] },
    ukPhone: {
      yes: [
        "07700 900123",
        "+44 7700 900123",
        "(01509) 123456",
        "0115 496 0000",
        "0 7 9 5 0 8 9 2 0 3 8", // letter-spaced extraction (Word "expanded" spacing)
        "07950\n\n892038", // split across lines
        "0044 7950 892038",
        "+44 (0)7950 892038",
      ],
      no: ["123", "2026", "01/02/1970", "123 456"],
    },
    niNumber: { yes: ["QQ123456C", "AB 12 34 56 D", "ab123456a"], no: ["AB123456E", "A1234567C"] },
    ukPostcode: { yes: ["DE74 2AB", "SW1A 1AA", "M1 1AE", "GIR 0AA"], no: ["12345", "DE74"] },
    date: { yes: ["01/02/1970", "1.2.70", "31-12-2026"], no: ["2026", "1/2"] },
  };
  for (const [key, { yes, no }] of Object.entries(cases)) {
    test(`${key} matches positives and rejects negatives`, () => {
      const [p] = core.compilePatterns({ presets: [key] });
      for (const s of yes) {
        p.re.lastIndex = 0;
        const m = p.re.exec(s);
        assert.ok(m, `${key} should match "${s}"`);
      }
      for (const s of no) {
        p.re.lastIndex = 0;
        assert.equal(p.re.exec(s)?.[0] === s, false, `${key} should not fully match "${s}"`);
      }
    });
  }
});

describe("geometry helpers", () => {
  test("mergeQuads joins a run and splits at separators", () => {
    const q = (x) => [x, 0, x + 5, 0, x, 10, x + 5, 10];
    const merged = core.mergeQuads([q(0), q(5), null, q(0)]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], [0, 0, 10, 0, 0, 10, 10, 10]);
  });

  test("quadBBox handles rotated quads", () => {
    assert.deepEqual(core.quadBBox([10, 0, 10, 20, 0, 0, 0, 20]), [0, 0, 10, 20]);
  });
});

// ------------------------------------------------------------------ opening

describe("openPrepared", () => {
  test("rejects non-PDF bytes", () => {
    assert.throws(() => core.openPrepared(mupdf, new TextEncoder().encode("hello")), { code: "BAD_PDF" });
  });

  test("encrypted: requires and checks the password", () => {
    const enc = fx.encrypted();
    assert.throws(() => core.openPrepared(mupdf, enc), { code: "NEEDS_PASSWORD" });
    assert.throws(() => core.openPrepared(mupdf, enc, { password: "wrong" }), { code: "BAD_PASSWORD" });
    assert.equal(core.openPrepared(mupdf, enc, { password: "pw" }).countPages(), 2);
  });
});

// ------------------------------------------------------------------ search

describe("findMatches", () => {
  let pdf;
  before(() => {
    pdf = core.openPrepared(mupdf, fx.kitchenSink());
  });

  test("finds every occurrence across pages, any case", () => {
    const hits = core.findMatches(pdf, core.compilePatterns({ terms: ["Smithers"] }));
    // p1: "John Smithers", "john.smithers@"; p2: "SMITHERS", "Smithers"
    assert.deepEqual(hits.map((h) => h.page), [0, 0, 1, 1]);
  });

  test("a name wrapped across lines yields one match with two quads", () => {
    const hits = core.findMatches(pdf, core.compilePatterns({ terms: ["was John Smithers"] }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].quads.length, 2);
  });

  test("invisible (render mode 3) and white text are searchable", () => {
    const hits = core.findMatches(pdf, core.compilePatterns({ terms: ["OCR layer secret", "Whitewashed secret"] }));
    assert.equal(hits.length, 2);
  });

  test("quads are in page space and sit where the text was drawn", () => {
    const [h] = core.findMatches(pdf, core.compilePatterns({ terms: ["Patient"] }));
    const [x0, y0] = core.quadBBox(h.quads[0]);
    assert.ok(Math.abs(x0 - 72) < 1, `x0=${x0}`);
    assert.ok(y0 > 55 && y0 < 80, `y0=${y0}`);
  });

  test("zero-length regex matches do not hang", () => {
    const hits = core.findMatches(pdf, core.compilePatterns({ regexes: ["x*"] }));
    assert.ok(Array.isArray(hits));
  });

  test("match cap prevents runaway result sets", () => {
    assert.throws(() => core.findMatches(pdf, core.compilePatterns({ regexes: ["."] }), { maxMatches: 10 }), {
      code: "TOO_MANY_MATCHES",
    });
  });
});

// ------------------------------------------------------------------ redaction

describe("redact: page content (verified with pdf.js)", () => {
  let result;
  let text;
  let input;
  let inputCopy;
  before(async () => {
    input = fx.kitchenSink();
    inputCopy = input.slice();
    result = runRedaction(input, {
      terms: ["John Smithers", "Smithers", "secret", "ACME-4471"],
      presets: ["email", "ukPhone", "niNumber", "ukPostcode", "date"],
      boxes: [
        { page: 0, rect: fx.VECTOR_RECT },
        // Left half of the image only, to prove pixel-level (not whole-image) removal.
        { page: 0, rect: [fx.IMAGE_RECT[0], fx.IMAGE_RECT[1], (fx.IMAGE_RECT[0] + fx.IMAGE_RECT[2]) / 2, fx.IMAGE_RECT[3]] },
      ],
      options: { fillBlack: false }, // so rendering shows what is left, not black boxes
    });
    text = (await pdfjsText(result.bytes)).toLowerCase();
  });

  test("core verification reports success", () => {
    assert.deepEqual(result.report.failures, []);
    assert.equal(result.report.ok, true);
  });

  for (const leaked of [
    "smithers",
    "john.smithers@example.com",
    "07700 900123",
    "qq 12 34 56 c",
    "de74 2ab",
    "01/02/1970",
    "acme-4471",
    "secret",
  ]) {
    test(`pdf.js cannot extract "${leaked}"`, () => {
      assert.ok(!text.includes(leaked), `found "${leaked}" in:\n${text}`);
    });
  }

  test("unrelated text survives", () => {
    assert.ok(text.includes("keep this sentence intact."));
    assert.ok(text.includes("confidential"));
  });

  test("redacted term absent from decompressed raw bytes", () => {
    assert.ok(!rawText(result.bytes).includes("smithers"));
  });

  test("covered vector art is removed", () => {
    assert.deepEqual(pixelAt(result.bytes, 0, centre(fx.VECTOR_RECT)), [255, 255, 255]);
  });

  test("image pixels under the box are cleared, the rest of the image kept", () => {
    const [x0, y0, x1, y1] = fx.IMAGE_RECT;
    const leftCentre = [x0 + (x1 - x0) / 4, (y0 + y1) / 2];
    const rightCentre = [x0 + (3 * (x1 - x0)) / 4, (y0 + y1) / 2];
    const [lr, lg, lb] = pixelAt(result.bytes, 0, leftCentre);
    const [rr, rg] = pixelAt(result.bytes, 0, rightCentre);
    assert.ok(lr > 240 && lg > 240 && lb > 240, `left half should be blank, got ${[lr, lg, lb]}`);
    assert.ok(rr > 180 && rg < 80, `right half should still be red, got ${[rr, rg]}`);
  });

  test("input buffer is not mutated", () => {
    assert.deepEqual(input, inputCopy);
  });

  test("output is a full rewrite, not an incremental update", () => {
    const s = Buffer.from(result.bytes).toString("latin1");
    assert.equal(s.match(/%%EOF/g).length, 1);
  });
});

describe("redact: black boxes", () => {
  test("fillBlack paints the redacted area black", () => {
    const { bytes } = runRedaction(fx.kitchenSink(), { boxes: [{ page: 0, rect: fx.VECTOR_RECT }] });
    assert.deepEqual(pixelAt(bytes, 0, centre(fx.VECTOR_RECT)), [0, 0, 0]);
  });
});

describe("redact: document-level scrubbing (verified with pdf.js)", () => {
  let doc;
  before(async () => {
    const { bytes } = runRedaction(fx.kitchenSink(), { terms: ["Smithers"] });
    doc = await pdfjsOpen(bytes);
  });

  test("Info dictionary and XMP removed", async () => {
    const { info, metadata } = await doc.getMetadata();
    for (const k of ["Title", "Author", "Subject"]) assert.equal(info[k], undefined, `${k} leaked`);
    assert.equal(metadata, null);
  });

  test("attachments removed", async () => {
    assert.equal(await doc.getAttachments(), null);
  });

  test("bookmarks removed", async () => {
    assert.equal(await doc.getOutline(), null);
  });

  test("comments and form fields removed", async () => {
    const page = await doc.getPage(1);
    assert.deepEqual(await page.getAnnotations(), []);
    assert.equal(await doc.getFieldObjects(), null);
  });

  test("structure tree (alt text) removed", async () => {
    const md = await doc.getMarkInfo();
    assert.ok(!md?.Marked);
    const page = await doc.getPage(1);
    assert.equal(await page.getStructTree(), null);
  });
});

describe("redact: options are respected", () => {
  test("disabling metadata removal keeps the title", async () => {
    const { bytes } = runRedaction(fx.kitchenSink(), { terms: ["nothing-matches"], options: { removeMetadata: false } });
    const doc = await pdfjsOpen(bytes);
    assert.equal((await doc.getMetadata()).info.Title, "Report on John Smithers");
  });

  test("disabling attachment removal keeps the attachment", async () => {
    const { bytes } = runRedaction(fx.kitchenSink(), { options: { removeAttachments: false } });
    const doc = await pdfjsOpen(bytes);
    assert.ok((await doc.getAttachments())?.get("notes.txt"));
  });

  test("bad method names are rejected", () => {
    assert.throws(() => core.redact(mupdf, fx.kitchenSink(), { options: { imageMethod: "blur" } }), { code: "BAD_OPTION" });
  });
});

describe("redact: awkward documents", () => {
  test("hidden layer content is revealed and removed by default", async () => {
    const { bytes, matches } = runRedaction(fx.hiddenLayer(), { terms: ["Smithers"] });
    assert.equal(matches.length, 1);
    const text = (await pdfjsText(bytes)).toLowerCase();
    assert.ok(!text.includes("smithers"));
    assert.ok(text.includes("visible line."));
    assert.ok(!rawText(bytes).includes("smithers"));
  });

  test("with revealHiddenLayers off, hidden content is NOT found — why the default is on", () => {
    const { matches, bytes } = runRedaction(fx.hiddenLayer(), { terms: ["Smithers"], options: { revealHiddenLayers: false } });
    assert.equal(matches.length, 0);
    assert.ok(rawText(bytes).includes("smithers"), "the secret is still in the file");
  });

  test("rotated page: matched text removed", async () => {
    const { bytes, report } = runRedaction(fx.rotated(), { terms: ["Smithers"] });
    assert.equal(report.ok, true, report.failures.join("; "));
    const text = (await pdfjsText(bytes)).toLowerCase();
    assert.ok(!text.includes("smithers"));
    assert.ok(text.includes("rotated secret"));
  });

  test("encrypted input: output is decrypted and clean", async () => {
    const { bytes, report } = runRedaction(fx.encrypted(), { terms: ["Smithers"], password: "pw" });
    assert.equal(report.ok, true, report.failures.join("; "));
    const text = (await pdfjsText(bytes)).toLowerCase(); // opens with no password
    assert.ok(!text.includes("smithers"));
  });

  test("50 pages complete in reasonable time", () => {
    const t0 = performance.now();
    const { matches, report } = runRedaction(fx.manyPages(50), { terms: ["Smithers"], regexes: ["ACME-\\d+"] });
    assert.equal(matches.length, 100);
    assert.equal(report.ok, true);
    assert.ok(performance.now() - t0 < 15000);
  });
});

describe("redact: Word-style CV (names in URLs, letter-spaced phone)", () => {
  let result;
  let squashed;
  before(async () => {
    result = runRedaction(fx.wordStyle(), { terms: ["John Smithers"], presets: ["ukPhone"] });
    // Remove whitespace so letter-spaced leftovers can't hide from the check.
    squashed = (await pdfjsText(result.bytes)).toLowerCase().replace(/\s+/g, "");
  });

  test("finds the phone number and every form of the name", () => {
    assert.deepEqual(
      result.matches.map((m) => m.text).sort(),
      ["0 7 9 5 0 8 9 2 0 3 8", "John_Smithers", "john-smithers", "johnsmithers"].sort(),
    );
  });

  test("verification passes", () => {
    assert.equal(result.report.ok, true, result.report.failures.join("; "));
  });

  test("pdf.js finds no phone digits or name forms", () => {
    for (const s of ["07950892038", "johnsmithers", "john_smithers", "john-smithers"]) {
      assert.ok(!squashed.includes(s), `"${s}" survived`);
    }
  });

  test("surrounding text survives", () => {
    assert.ok(squashed.includes("smithersj.com"), "a different token must not be touched");
    assert.ok(squashed.includes("unrelated:smithandsonsltd"));
    assert.ok(squashed.includes(".org"));
  });

  test("match edges are trimmed of whitespace", () => {
    const [m] = core.findMatches(
      core.openPrepared(mupdf, fx.kitchenSink()),
      core.compilePatterns({ presets: ["ukPhone"] }),
    );
    assert.equal(m.text, "07700 900123");
  });
});

describe("redact: input validation", () => {
  test("out-of-range page", () => {
    assert.throws(() => core.redact(mupdf, fx.rotated(), { boxes: [{ page: 5, rect: [0, 0, 10, 10] }] }), { code: "BAD_PAGE" });
  });

  test("malformed rect", () => {
    assert.throws(() => core.redact(mupdf, fx.rotated(), { boxes: [{ page: 0, rect: [0, 0, "x", 10] }] }), { code: "BAD_RECT" });
  });

  test("inverted rect is normalised, not rejected", () => {
    const { report } = core.redact(mupdf, fx.rotated(), { boxes: [{ page: 0, rect: [100, 100, 0, 0] }] });
    assert.equal(report.ok, true);
  });
});

// ------------------------------------------------------------------ the verifier itself

describe("verify catches failures (testing the tester)", () => {
  const patterns = core.compilePatterns({ terms: ["Smithers"] });

  test("unredacted original fails pattern and metadata checks", () => {
    const r = core.verify(mupdf, fx.kitchenSink(), { patterns });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes("still present (Smithers)")));
    assert.ok(r.failures.some((f) => f.startsWith("Metadata Title")));
    assert.ok(r.failures.some((f) => f.includes("XMP")));
    assert.ok(r.failures.some((f) => f.includes("Embedded files")));
    assert.ok(r.failures.some((f) => f.includes("Bookmarks")));
    assert.ok(r.failures.some((f) => f.includes("annotations")));
  });

  test("text left under a box is reported", () => {
    // "Keep this sentence intact." sits at top≈140; claim we redacted that area.
    const r = core.verify(mupdf, fx.rotated(), { boxes: [{ page: 0, rect: [0, 0, 842, 595] }] });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes("inside a redacted area")));
  });

  test("deliberately excluded matches are not reported as leaks, but others are", () => {
    const bytes = fx.kitchenSink();
    const pats = core.compilePatterns({ terms: ["confidential", "Patient"] });
    const all = core.findMatches(core.openPrepared(mupdf, bytes), pats);
    const keep = all.filter((m) => m.label === "confidential");
    const { report } = core.redact(mupdf, bytes, { matches: [], excluded: keep, patterns: pats });
    assert.equal(report.ok, false, "Patient was neither redacted nor excluded");
    assert.ok(report.failures.every((f) => !f.includes("confidential")));
    assert.ok(report.failures.some((f) => f.includes("Patient")));
    assert.ok(report.warnings.some((w) => w.includes("kept by choice")));
  });

  test("raw-byte warning fires when a term survives outside page text", () => {
    const { bytes } = runRedaction(fx.kitchenSink(), { terms: ["Smithers"], options: { removeMetadata: false } });
    const r = core.verify(mupdf, bytes, { patterns, options: { removeMetadata: false } });
    assert.ok(r.warnings.some((w) => w.includes("smithers")));
  });

  test("raw-byte scan copes with large files (regression: stack overflow in browser workers)", () => {
    const big = fx.scanned(); // a full-page bitmap: hundreds of KB once decompressed
    assert.ok(rawText(big).length > 200_000);
    const r = core.verify(mupdf, big, { patterns: core.compilePatterns({ terms: ["anything"] }) });
    assert.equal(typeof r.ok, "boolean");
  });

  test("garbage output is reported, not thrown", () => {
    const r = core.verify(mupdf, new Uint8Array([1, 2, 3]), {});
    assert.equal(r.ok, false);
  });
});

// ------------------------------------------------------------------ rendering

describe("renderPage", () => {
  test("returns a PNG of the expected size", () => {
    const pdf = core.openPrepared(mupdf, fx.kitchenSink());
    const r = core.renderPage(mupdf, pdf, 0, 2);
    assert.deepEqual([...r.png.slice(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
    assert.equal(r.width, fx.PAGE_W * 2);
    assert.equal(r.height, fx.PAGE_H * 2);
  });
});
