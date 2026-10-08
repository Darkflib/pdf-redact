// SPDX-License-Identifier: AGPL-3.0-or-later
//
// core.js — redaction logic shared by the browser worker and the Node test suite.
//
// Everything here is a pure function of (mupdf module, input bytes, options). The
// mupdf module is injected rather than imported so the same file runs unchanged in
// a Web Worker (vendored build) and under Node (npm package).
//
// Coordinate space: MuPDF "page space" — origin top-left, y grows downwards, units
// are PDF points, rotation and CropBox already applied. Search quads, render output
// and Redact annotation rects all live in this space, so nothing here converts.
//
// Quad layout (MuPDF): [ulx, uly, urx, ury, llx, lly, lrx, lry].

/** Built-in patterns. Deliberately conservative: false negatives are the dangerous
 *  failure for a redaction tool, but wildly greedy patterns make review useless. */
export const PRESETS = Object.freeze({
  email: {
    label: "Email address",
    source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  },
  ukPhone: {
    label: "UK phone number",
    // +44 / 0 prefix, then 9–10 digits with optional spaces, dashes or brackets.
    source: String.raw`(?:\+44\s?\(?0?\)?\s?|\(?0)(?:\d\)?[\s-]?){9,10}\d?`,
  },
  niNumber: {
    label: "UK National Insurance number",
    // Deliberately looser than HMRC's issuing rules (which exclude prefixes such as
    // QQ, HMRC's own specimen): a missed match is worse than an extra one to review.
    source: String.raw`\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b`,
  },
  ukPostcode: {
    label: "UK postcode",
    source: String.raw`\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[ABD-HJLNP-UW-Z]{2})\b`,
  },
  date: {
    label: "Date (dd/mm/yyyy and similar)",
    source: String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b`,
  },
});

export const DEFAULT_OPTIONS = Object.freeze({
  fillBlack: true, // draw black boxes where content was removed
  imageMethod: "pixels", // "pixels" | "remove" | "none"
  lineArtMethod: "covered", // "covered" | "touched" | "none"
  removeMetadata: true, // Info dictionary, XMP, PieceInfo
  removeAttachments: true, // EmbeddedFiles name tree
  removeOutlines: true, // bookmarks
  removeAnnotations: true, // comments, links, form fields (AcroForm)
  removeStructure: true, // tagged-PDF structure tree (holds /Alt and /ActualText)
  revealHiddenLayers: true, // drop OCProperties so hidden layer content is searchable/redactable
  caseSensitive: false,
});

const SEPARATOR = null; // quad placeholder for synthetic line/block breaks

export class RedactionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RedactionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- patterns

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn user input into labelled global RegExps.
 * Literal terms tolerate any run of whitespace between words, so a name wrapped
 * across a line break ("John\nSmithers") is still matched.
 * @throws {RedactionError} on an invalid user regex, naming which one.
 */
export function compilePatterns({ terms = [], regexes = [], presets = [] } = {}, options = {}) {
  const flags = "gu" + (options.caseSensitive ? "" : "i");
  const out = [];
  for (const raw of terms) {
    const t = String(raw).trim();
    if (!t) continue;
    const source = t.split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
    out.push({ kind: "term", label: t, re: new RegExp(source, flags) });
  }
  for (const raw of regexes) {
    const src = String(raw).trim();
    if (!src) continue;
    try {
      out.push({ kind: "regex", label: `/${src}/`, re: new RegExp(src, flags) });
    } catch (e) {
      throw new RedactionError(`Invalid regular expression /${src}/: ${e.message}`, "BAD_REGEX");
    }
  }
  for (const key of presets) {
    const p = PRESETS[key];
    if (!p) throw new RedactionError(`Unknown preset "${key}"`, "BAD_PRESET");
    // Presets are written for the stated case; NI numbers and postcodes are matched
    // case-insensitively anyway because scanned/OCR text is often lower-cased.
    out.push({ kind: "preset", label: p.label, re: new RegExp(p.source, "gui") });
  }
  return out;
}

// ---------------------------------------------------------------- document prep

/**
 * Open bytes as a PDF, authenticate, and apply the content-affecting preprocessing
 * that must be identical for preview, search and redaction (so what the user
 * reviews is what gets written).
 */
export function openPrepared(mupdf, bytes, { password = "", options = {} } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let doc;
  try {
    // Copy: MuPDF may hold the buffer, and callers must be able to reuse theirs.
    doc = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf");
  } catch (e) {
    throw new RedactionError(`Could not open file as PDF: ${e.message}`, "BAD_PDF");
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new RedactionError("Not a PDF document", "BAD_PDF");
  if (pdf.needsPassword()) {
    if (!password) throw new RedactionError("This PDF is password protected", "NEEDS_PASSWORD");
    if (!pdf.authenticatePassword(password)) {
      throw new RedactionError("Incorrect password", "BAD_PASSWORD");
    }
  }
  const root = pdf.getTrailer().get("Root");
  if (opts.revealHiddenLayers && !root.get("OCProperties").isNull()) {
    // Without OCProperties every optional-content group renders. Hidden layers are a
    // classic leak: invisible in the viewer, extractable by anyone.
    root.delete("OCProperties");
  }
  if (opts.removeAnnotations) removeAnnotations(pdf);
  return pdf;
}

function removeAnnotations(pdf) {
  const n = pdf.countPages();
  for (let i = 0; i < n; i++) pdf.findPage(i).delete("Annots");
  pdf.getTrailer().get("Root").delete("AcroForm");
}

// ---------------------------------------------------------------- text & search

/**
 * Linearise a page's structured text into a string plus a parallel array of quads,
 * one per UTF-16 code unit, with SEPARATOR at synthetic line breaks.
 * Includes invisible text (render mode 3, e.g. OCR layers): it is still extractable,
 * so it must be findable.
 */
export function pageText(page) {
  const st = page.toStructuredText("preserve-whitespace,preserve-spans");
  const chars = [];
  const quads = [];
  try {
    st.walk({
      onChar(c, _origin, _font, _size, quad) {
        // Astral characters are two code units; keep the arrays aligned.
        for (let k = 0; k < c.length; k++) {
          chars.push(c[k]);
          quads.push(quad);
        }
      },
      endLine() {
        chars.push("\n");
        quads.push(SEPARATOR);
      },
      endTextBlock() {
        chars.push("\n");
        quads.push(SEPARATOR);
      },
    });
  } finally {
    st.destroy?.();
  }
  return { text: chars.join(""), quads };
}

/** Merge per-character quads into one quad per visual line run. */
export function mergeQuads(charQuads) {
  const out = [];
  let first = null;
  let last = null;
  const flush = () => {
    if (first) out.push([first[0], first[1], last[2], last[3], first[4], first[5], last[6], last[7]]);
    first = last = null;
  };
  for (const q of charQuads) {
    if (q === SEPARATOR) {
      flush();
      continue;
    }
    // A big backwards jump in x means a new line even without an explicit break.
    if (last && q[0] < last[0] - 1 && Math.abs(q[1] - last[1]) > 1) flush();
    if (!first) first = q;
    last = q;
  }
  flush();
  return out;
}

/** Axis-aligned bounding box of a quad, as [x0, y0, x1, y1]. */
export function quadBBox(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Find every pattern match in the document.
 * @returns {{page:number, label:string, text:string, quads:number[][]}[]}
 */
export function findMatches(pdf, patterns, { maxMatches = 10000 } = {}) {
  const results = [];
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    const page = pdf.loadPage(p);
    const { text, quads } = pageText(page);
    for (const { label, re } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++; // guard against zero-length matches looping forever
          continue;
        }
        const hit = quads.slice(m.index, m.index + m[0].length);
        const merged = mergeQuads(hit);
        if (merged.length) {
          results.push({ page: p, label, text: m[0].replace(/\s+/g, " ").trim(), quads: merged });
        }
        if (results.length >= maxMatches) {
          throw new RedactionError(
            `More than ${maxMatches} matches — refine the pattern`,
            "TOO_MANY_MATCHES",
          );
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------- redaction

function methodConstants(mupdf, opts) {
  const P = mupdf.PDFPage;
  const image = { pixels: P.REDACT_IMAGE_PIXELS, remove: P.REDACT_IMAGE_REMOVE, none: P.REDACT_IMAGE_NONE }[opts.imageMethod];
  const line = {
    covered: P.REDACT_LINE_ART_REMOVE_IF_COVERED,
    touched: P.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
    none: P.REDACT_LINE_ART_NONE,
  }[opts.lineArtMethod];
  if (image === undefined) throw new RedactionError(`Unknown imageMethod ${opts.imageMethod}`, "BAD_OPTION");
  if (line === undefined) throw new RedactionError(`Unknown lineArtMethod ${opts.lineArtMethod}`, "BAD_OPTION");
  return { image, line };
}

/** Number of keys in a PDF dictionary. (PDFObject.length is only meaningful for arrays.) */
function dictSize(obj) {
  let n = 0;
  obj.forEach(() => n++);
  return n;
}

/** Remove document-level data that redaction of page content does not touch. */
export function scrubDocument(pdf, opts) {
  const trailer = pdf.getTrailer();
  const root = trailer.get("Root");

  // Active content is never wanted in a redacted document.
  root.delete("OpenAction");
  root.delete("AA");
  const names = root.get("Names");
  if (!names.isNull()) names.delete("JavaScript");

  if (opts.removeMetadata) {
    trailer.delete("Info");
    root.delete("Metadata");
    root.delete("PieceInfo");
    root.delete("SpiderInfo");
  }
  if (opts.removeAttachments) {
    for (const name of Object.keys(pdf.getEmbeddedFiles())) pdf.deleteEmbeddedFile(name);
    if (!names.isNull()) names.delete("EmbeddedFiles");
    root.delete("AF"); // PDF 2.0 associated files
  }
  if (opts.removeOutlines) {
    root.delete("Outlines");
    const mode = root.get("PageMode");
    if (mode.isName() && mode.asName() === "UseOutlines") root.delete("PageMode");
  }
  if (opts.removeStructure) {
    root.delete("StructTreeRoot");
    root.delete("MarkInfo");
  }
  if (opts.removeOutlines && opts.removeAnnotations) {
    // Nothing can reference named destinations any more, and their names can leak.
    root.delete("Dests");
    if (!names.isNull()) names.delete("Dests");
  }
  if (!names.isNull() && dictSize(names) === 0) root.delete("Names");

  const n = pdf.countPages();
  for (let i = 0; i < n; i++) {
    const pageObj = pdf.findPage(i);
    if (opts.removeMetadata) {
      pageObj.delete("Metadata");
      pageObj.delete("PieceInfo");
    }
    if (opts.removeStructure) pageObj.delete("StructParents");
    if (opts.removeAttachments) pageObj.delete("AF");
    pageObj.delete("AA");
  }
}

/**
 * Apply redactions and return a fresh, fully rewritten PDF plus a verification report.
 *
 * @param {object} mupdf      the mupdf module
 * @param {Uint8Array} bytes  original PDF (not modified)
 * @param {object} spec
 *   matches: [{page, quads}]  regions from findMatches (user may have pruned)
 *   boxes:   [{page, rect:[x0,y0,x1,y1]}]  hand-drawn regions
 *   patterns: compiled patterns, re-run against the output for verification
 *   excluded: [{page, quads}]  matches the user deliberately chose to keep; the
 *             verifier will not report them as leaks
 *   password, options
 */
export function redact(
  mupdf,
  bytes,
  { matches = [], boxes = [], patterns = [], excluded = [], password = "", options = {} } = {},
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { image, line } = methodConstants(mupdf, opts);
  const pdf = openPrepared(mupdf, bytes, { password, options: opts });
  const pageCount = pdf.countPages();

  const byPage = new Map();
  const add = (page, item) => {
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      throw new RedactionError(`Redaction refers to page ${page}, document has ${pageCount}`, "BAD_PAGE");
    }
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(item);
  };
  for (const m of matches) add(m.page, { quads: m.quads });
  for (const b of boxes) add(b.page, { rect: normaliseRect(b.rect) });

  for (const [p, items] of byPage) {
    const page = pdf.loadPage(p);
    for (const it of items) {
      const annot = page.createAnnotation("Redact");
      if (it.quads) annot.setQuadPoints(it.quads);
      else annot.setRect(it.rect);
    }
    page.applyRedactions(opts.fillBlack, image, line, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  }
  if (opts.removeAnnotations) removeAnnotations(pdf);
  scrubDocument(pdf, opts);

  // Full rewrite: no incremental update section (which would retain the original
  // page content), unreferenced objects collected, content streams sanitised.
  // Encryption is dropped: a redacted document is normally for release, and an
  // encrypted output could not be verified without the password.
  const out = pdf.saveToBuffer("garbage=4,compress,clean,sanitize,encrypt=none").asUint8Array().slice();
  pdf.destroy?.();

  const report = verify(mupdf, out, { patterns, matches, boxes, excluded, options: opts });
  return { bytes: out, report };
}

function normaliseRect(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) {
    throw new RedactionError(`Invalid rectangle ${JSON.stringify(r)}`, "BAD_RECT");
  }
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

// ---------------------------------------------------------------- verification

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** Characters whose centre lies inside any of the rects. */
function charsInRects(page, rects) {
  const found = [];
  const { text, quads } = pageText(page);
  for (let i = 0; i < text.length; i++) {
    const q = quads[i];
    if (q === SEPARATOR || /\s/.test(text[i])) continue;
    const bb = quadBBox(q);
    const cx = (bb[0] + bb[2]) / 2;
    const cy = (bb[1] + bb[3]) / 2;
    if (rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) found.push(text[i]);
  }
  return found.join("");
}

/**
 * Independently re-open the output and check nothing that should be gone remains.
 * Failures are things that are definitely wrong; warnings need a human to look.
 */
export function verify(
  mupdf,
  outBytes,
  { patterns = [], matches = [], boxes = [], excluded = [], options = {} } = {},
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const failures = [];
  const warnings = [];
  let pdf;
  try {
    pdf = mupdf.Document.openDocument(new Uint8Array(outBytes).slice(), "application/pdf").asPDF();
  } catch (e) {
    return { ok: false, failures: [`Output does not open as a PDF: ${e.message}`], warnings };
  }
  if (pdf.needsPassword()) warnings.push("Output is encrypted; verification may be incomplete");

  // 1. Patterns must find nothing, except where the user deliberately kept a match.
  const kept = excluded.map((e) => ({ page: e.page, rects: e.quads.map(quadBBox) }));
  const isKept = (hit) =>
    kept.some((k) => k.page === hit.page && hit.quads.some((q) => k.rects.some((r) => intersects(quadBBox(q), r))));
  let keptCount = 0;
  for (const hit of findMatches(pdf, patterns)) {
    if (isKept(hit)) keptCount++;
    else failures.push(`Page ${hit.page + 1}: "${hit.text}" still present (${hit.label})`);
  }
  if (keptCount) warnings.push(`${keptCount} match${keptCount === 1 ? "" : "es"} kept by choice (unticked)`);

  // 2. No extractable text inside any redacted region.
  const regions = new Map();
  for (const m of matches) {
    const list = regions.get(m.page) ?? [];
    list.push(...m.quads.map(quadBBox));
    regions.set(m.page, list);
  }
  for (const b of boxes) {
    const list = regions.get(b.page) ?? [];
    list.push(normaliseRect(b.rect));
    regions.set(b.page, list);
  }
  for (const [p, rects] of regions) {
    if (p >= pdf.countPages()) continue;
    // Shrink slightly so glyphs that merely touch the edge are not flagged.
    const inset = rects.map((r) => [r[0] + 0.5, r[1] + 0.5, r[2] - 0.5, r[3] - 0.5]);
    const left = charsInRects(pdf.loadPage(p), inset);
    if (left) failures.push(`Page ${p + 1}: text remains inside a redacted area: "${left.slice(0, 60)}"`);
  }

  // 3. Document-level structures.
  const trailer = pdf.getTrailer();
  const root = trailer.get("Root");
  if (opts.removeMetadata) {
    if (!trailer.get("Info").isNull()) {
      for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]) {
        const v = pdf.getMetaData(`info:${k}`);
        if (v) failures.push(`Metadata ${k} still present: "${v}"`);
      }
    }
    if (!root.get("Metadata").isNull()) failures.push("XMP metadata stream still present");
  }
  if (opts.removeAttachments && Object.keys(pdf.getEmbeddedFiles()).length) {
    failures.push("Embedded files still present");
  }
  if (opts.removeOutlines && !root.get("Outlines").isNull()) failures.push("Bookmarks still present");
  if (opts.removeStructure && !root.get("StructTreeRoot").isNull()) failures.push("Structure tree still present");
  if (opts.removeAnnotations) {
    if (!root.get("AcroForm").isNull()) failures.push("Form fields still present");
    for (let i = 0; i < pdf.countPages(); i++) {
      if (!pdf.findPage(i).get("Annots").isNull()) failures.push(`Page ${i + 1}: annotations still present`);
    }
  }

  // 4. Raw-byte scan for literal terms in a decompressed copy. Content-stream text is
  //    font-encoded, so this mainly catches strings in dictionaries the scrub missed.
  //    Short or common terms can false-positive on font names, hence a warning.
  const terms = patterns.filter((p) => p.kind === "term").map((p) => p.label.toLowerCase());
  if (terms.length) {
    const raw = pdf.saveToBuffer("decompress").asUint8Array();
    let latin = "";
    for (let i = 0; i < raw.length; i += 65536) {
      latin += String.fromCharCode.apply(null, raw.subarray(i, i + 65536));
    }
    latin = latin.toLowerCase();
    for (const t of terms) if (latin.includes(t)) warnings.push(`Raw bytes contain "${t}" — inspect manually`);
  }

  pdf.destroy?.();
  return { ok: failures.length === 0, failures, warnings };
}

// ---------------------------------------------------------------- rendering

/** Render a page to PNG at the given zoom. Returns offsets so overlays line up. */
export function renderPage(mupdf, pdf, index, zoom = 1.5) {
  const page = pdf.loadPage(index);
  const bounds = page.getBounds();
  const pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return {
      png: pix.asPNG().slice(),
      width: pix.getWidth(),
      height: pix.getHeight(),
      originX: pix.getX(), // pixel offset of page-space origin
      originY: pix.getY(),
      zoom,
      bounds,
    };
  } finally {
    pix.destroy?.();
  }
}
