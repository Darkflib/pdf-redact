// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ocr.js — turn Tesseract output into the same {text, quads} shape that
// core.pageText() produces, so OCR text goes through the same search, match
// and redaction path as real text.
//
// Pure functions only; the Tesseract worker itself is driven by the UI (browser)
// or the tests (Node).

/** Pixel-space bbox → page-space quad. `origin*` are the pixmap offsets from renderPage. */
function toQuad({ x0, y0, x1, y1 }, { zoom, originX = 0, originY = 0 }) {
  const ax = (x0 + originX) / zoom;
  const ay = (y0 + originY) / zoom;
  const bx = (x1 + originX) / zoom;
  const by = (y1 + originY) / zoom;
  return [ax, ay, bx, ay, ax, by, bx, by];
}

/**
 * Character boxes for a word: Tesseract's per-symbol boxes when present,
 * otherwise the word box split evenly across its characters.
 *
 * Every box gets the full height of its line (`band`). Per-glyph heights vary
 * ("J" vs "o"), and merging the first and last glyph of a run into one quad would
 * otherwise produce a slanted shape that misses ink. Full-line height also
 * covers ascenders and descenders.
 */
function wordChars(word, band) {
  const chars = Array.from(word.text ?? "");
  const symbols = word.symbols ?? [];
  const joined = symbols.map((s) => s.text).join("");
  if (symbols.length && joined === word.text) {
    // Symbols can be multi-code-unit; expand so text and boxes stay aligned.
    return symbols.flatMap((s) =>
      Array.from(s.text).map((c) => ({ c, bbox: { x0: s.bbox.x0, x1: s.bbox.x1, ...band } })),
    );
  }
  const { x0, x1 } = word.bbox;
  const w = (x1 - x0) / Math.max(1, chars.length);
  return chars.map((c, i) => ({ c, bbox: { x0: x0 + i * w, x1: x0 + (i + 1) * w, ...band } }));
}

/**
 * Convert Tesseract `blocks` output to {text, quads}.
 * @param {object[]} blocks   data.blocks from recognize(..., {blocks: true})
 * @param {object} geom       {zoom, originX, originY} from renderPage
 * @param {number} minConfidence  words below this are still included — a
 *        low-confidence word may be exactly the name you need gone — but the
 *        count is reported so the UI can say so.
 */
export function ocrBlocksToText(blocks, geom, { minConfidence = 60 } = {}) {
  const chars = [];
  const quads = [];
  let lowConfidence = 0;
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        let first = true;
        // Vertical band shared by every glyph on the line: the line box, widened to
        // include any word or glyph that pokes out of it.
        const words = (line.words ?? []).filter((wd) => wd.text);
        const boxes = [line.bbox, ...words.map((wd) => wd.bbox), ...words.flatMap((wd) => (wd.symbols ?? []).map((sy) => sy.bbox))].filter(Boolean);
        if (!boxes.length) continue;
        const band = { y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)) };
        for (const word of words) {
          if (word.confidence < minConfidence) lowConfidence++;
          if (!first) {
            chars.push(" ");
            quads.push(null);
          }
          first = false;
          for (const { c, bbox } of wordChars(word, band)) {
            for (let k = 0; k < c.length; k++) {
              chars.push(c[k]);
              quads.push(toQuad(bbox, geom));
            }
          }
        }
        chars.push("\n");
        quads.push(null);
      }
      chars.push("\n");
      quads.push(null);
    }
  }
  return { text: chars.join(""), quads, lowConfidence };
}
