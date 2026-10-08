// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCR path: scanned pages have no text layer, so Tesseract supplies the text and
// MuPDF removes the pixels. The final check re-runs Tesseract on the *output* —
// a different engine from the one that did the redaction.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { createWorker } from "tesseract.js";
import * as core from "../src/core.js";
import { ocrBlocksToText } from "../src/ocr.js";
import * as fx from "./fixtures.mjs";

const LANG_PATH = fileURLToPath(new URL("../node_modules/@tesseract.js-data/eng/4.0.0_best_int", import.meta.url));
const OCR_ZOOM = 3;

let worker;
before(async () => {
  worker = await createWorker("eng", 1, { langPath: LANG_PATH, cacheMethod: "none", gzip: true });
});
after(async () => {
  await worker?.terminate();
});

/** OCR every page of a PDF; returns the extraText map that findMatches takes. */
async function ocrDocument(bytes) {
  const pdf = core.openPrepared(mupdf, bytes);
  const extra = {};
  for (let p = 0; p < pdf.countPages(); p++) {
    const r = core.renderPage(mupdf, pdf, p, OCR_ZOOM);
    const { data } = await worker.recognize(Buffer.from(r.png), {}, { blocks: true });
    extra[p] = ocrBlocksToText(data.blocks, r);
  }
  return extra;
}

describe("ocrBlocksToText", () => {
  const geom = { zoom: 2, originX: 0, originY: 0 };
  const word = (text, x0, symbols = true) => ({
    text,
    confidence: 95,
    bbox: { x0, y0: 10, x1: x0 + text.length * 10, y1: 30 },
    symbols: symbols
      ? Array.from(text).map((c, i) => ({ text: c, bbox: { x0: x0 + i * 10, y0: 10, x1: x0 + (i + 1) * 10, y1: 30 } }))
      : undefined,
  });
  const blocks = (words) => [{ paragraphs: [{ lines: [{ words }] }] }];

  test("builds text with spaces and line breaks, quads in page space", () => {
    const { text, quads } = ocrBlocksToText(blocks([word("Hi", 0), word("there", 40)]), geom);
    assert.equal(text, "Hi there\n\n");
    assert.deepEqual(quads[0], [0, 5, 5, 5, 0, 15, 5, 15]); // pixel/zoom
    assert.equal(quads[2], null); // the synthetic space
    assert.equal(text.length, quads.length);
  });

  test("pixmap origin offsets are applied", () => {
    const { quads } = ocrBlocksToText(blocks([word("A", 0)]), { zoom: 2, originX: 20, originY: 40 });
    assert.deepEqual(quads[0], [10, 25, 15, 25, 10, 35, 15, 35]);
  });

  test("every glyph on a line shares the line's height, so merged boxes stay rectangular", () => {
    const tall = word("Jo", 0);
    tall.symbols[0].bbox.y0 = 4; // "J" taller than "o"
    const { quads } = ocrBlocksToText([{ paragraphs: [{ lines: [{ bbox: { x0: 0, y0: 6, x1: 20, y1: 32 }, words: [tall] }] }] }], geom);
    assert.equal(quads[0][1], quads[1][1], "same top");
    assert.equal(quads[0][5], quads[1][5], "same bottom");
    assert.equal(quads[0][1], 2, "band reaches the tallest glyph (y0=4px → 2pt)");
    assert.equal(quads[0][5], 16, "and the line's bottom (y1=32px → 16pt)");
  });

  test("falls back to splitting the word box when symbols are missing", () => {
    const { quads } = ocrBlocksToText(blocks([word("abcd", 0, false)]), geom);
    assert.equal(quads[1][0], 5); // second char starts a quarter of the way in
  });

  test("low-confidence words are kept but counted", () => {
    const w = word("Smith", 0);
    w.confidence = 20;
    const r = ocrBlocksToText(blocks([w]), geom);
    assert.ok(r.text.startsWith("Smith"));
    assert.equal(r.lowConfidence, 1);
  });

  test("empty input", () => {
    assert.deepEqual(ocrBlocksToText([], geom), { text: "", quads: [], lowConfidence: 0 });
  });
});

describe("scanned page, end to end", () => {
  let input;
  let extra;
  let matches;
  let result;
  let reOcr;

  before(async () => {
    input = fx.scanned();
    extra = await ocrDocument(input);
    const patterns = core.compilePatterns({ terms: ["John Smithers"], presets: ["ukPhone"] });
    matches = core.findMatches(core.openPrepared(mupdf, input), patterns, { extraText: extra });
    result = core.redact(mupdf, input, { matches, patterns });
    const outExtra = await ocrDocument(result.bytes);
    reOcr = outExtra[0].text.toLowerCase();
  });

  test("the page has no real text — search alone would find nothing", () => {
    const pdf = core.openPrepared(mupdf, input);
    assert.equal(core.pageText(pdf.loadPage(0)).text.trim(), "");
  });

  test("OCR finds the name and the phone number", () => {
    assert.deepEqual(matches.map((m) => [m.source, m.text]).sort(), [
      ["ocr", "07700 900123"],
      ["ocr", "John Smithers"],
    ]);
  });

  test("OCR quads sit where the text is on the page", () => {
    const name = matches.find((m) => m.text === "John Smithers");
    const [x0, y0, x1, y1] = core.quadBBox(name.quads[0]);
    // The fixture draws the line at x=72, top≈80, 16pt; "John" starts part-way along.
    assert.ok(x0 > 150 && x1 < 400, `x ${x0}-${x1}`);
    assert.ok(y0 > 75 && y1 < 110, `y ${y0}-${y1}`);
  });

  test("verification passes and says it checked pixels", () => {
    assert.equal(result.report.ok, true, result.report.failures.join("; "));
    assert.ok(result.report.warnings.some((w) => w.includes("checked by pixels")));
  });

  test("re-running OCR on the output cannot read the name or number", () => {
    assert.ok(!reOcr.includes("smithers"), reOcr);
    assert.ok(!reOcr.replace(/\s+/g, "").includes("900123"), reOcr);
  });

  test("the rest of the scan survives", () => {
    assert.ok(reOcr.includes("keep this line intact"), reOcr);
    assert.ok(reOcr.includes("scanned letter"), reOcr);
  });

  test("pixel check catches a scan that was NOT cleared", () => {
    // Leave images untouched and draw no box: the scan is still fully readable.
    const patterns = core.compilePatterns({ terms: ["John Smithers"] });
    const bad = core.redact(mupdf, input, {
      matches: matches.filter((m) => m.text === "John Smithers"),
      patterns,
      options: { imageMethod: "none", fillBlack: false },
    });
    assert.equal(bad.report.ok, false);
    assert.ok(bad.report.failures.some((f) => f.includes("scanned content still visible")));
  });
});
