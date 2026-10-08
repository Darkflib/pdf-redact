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

// ---------------------------------------------------------------- preset helpers

/** n digits, tolerating one space between digits (letter-spaced extraction: "1 2 3"). */
const digits = (n) => String.raw`\d(?:\s?\d){${n - 1}}`;
/** Separator between digit groups: dashes, dots or spaces, in any run. */
const SEP = String.raw`[\s.-]*`;
/** Not glued to more digits on either side (so we don't match inside a longer number). */
const NO_DIGIT_BEFORE = String.raw`(?<![\d-])`;
const NO_DIGIT_AFTER = String.raw`(?!\d)`;
const onlyDigits = (s) => s.replace(/\D/g, "");

/** Luhn checksum, used by every major payment card scheme. */
export function luhnValid(number) {
  const d = onlyDigits(number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** ABA routing number: valid Federal Reserve prefix and the 3-7-1 weighted checksum. */
export function abaValid(number) {
  const d = onlyDigits(number);
  if (d.length !== 9) return false;
  const prefix = Number(d.slice(0, 2));
  const okPrefix = prefix <= 12 || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80;
  if (!okPrefix) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return [...d].reduce((acc, c, i) => acc + (c.charCodeAt(0) - 48) * w[i], 0) % 10 === 0;
}

/** SSN issuing rules: area not 000, 666 or 9xx; group not 00; serial not 0000. */
export function ssnValid(text) {
  const d = onlyDigits(text);
  if (d.length !== 9) return false;
  const [area, group, serial] = [d.slice(0, 3), d.slice(3, 5), d.slice(5)];
  return area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";
}

/** ITIN: 9xx area and a group in the ranges the IRS issues. */
export function itinValid(text) {
  const d = onlyDigits(text);
  if (d.length !== 9 || d[0] !== "9") return false;
  const g = Number(d.slice(3, 5));
  return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99);
}

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR|GU|VI|AS|MP";
const MONTH =
  String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
// Medicare Beneficiary Identifier alphabet: letters except S, L, O, I, B, Z.
const MBI_A = "[AC-HJKMNP-RT-Y]";
const MBI_AN = "[AC-HJKMNP-RT-Y0-9]";

/**
 * Built-in patterns. Deliberately conservative: false negatives are the dangerous
 * failure for a redaction tool, but wildly greedy patterns make review useless.
 *
 *   region      groups the UI: "UK", "US" or "General"
 *   source      the regex
 *   flags       default "gui"; case-sensitive where case carries meaning
 *   validate    optional check on the matched text, for rules a regex can't
 *               express (checksums). A failed check means "not this kind of
 *               number", so the match is dropped.
 */
export const PRESETS = Object.freeze({
  // ---- General
  email: {
    region: "General",
    label: "Email address",
    source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  },
  date: {
    region: "General",
    label: "Date in numbers (01/02/1970, 1-2-70)",
    // Order-agnostic, so it covers dd/mm (UK) and mm/dd (US) alike.
    source: String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b`,
  },
  dateWords: {
    region: "General",
    label: "Date in words (5 January 2026, Jan. 5th, 2026)",
    source: String.raw`\b\d{1,2}${ORD}\s+(?:of\s+)?${MONTH},?\s+\d{4}\b|\b${MONTH}\s+\d{1,2}${ORD},?\s+\d{4}\b`,
  },
  paymentCard: {
    region: "General",
    label: "Payment card number (Luhn-checked)",
    // 13–19 digits in any grouping; the checksum weeds out ordinary long numbers.
    source: String.raw`${NO_DIGIT_BEFORE}\d(?:[\s-]?\d){12,18}${NO_DIGIT_AFTER}`,
    validate: luhnValid,
  },

  // ---- UK
  ukPhone: {
    region: "UK",
    label: "UK phone number",
    // +44 / 0044 / 0 prefix, then 9–10 digits. Any run of separators is allowed
    // between digits (including after the leading 0): PDFs from Word often have
    // wide character spacing that text extraction turns into "0 7 9 5 0 …".
    source: String.raw`(?:(?:\+|\b00)\s*44[\s.-]*(?:\(\s*0\s*\)[\s.-]*)?|\(?\b0[\s.)-]*)(?:\d[\s.)-]*){8,9}\d`,
  },
  niNumber: {
    region: "UK",
    label: "UK National Insurance number",
    // Deliberately looser than HMRC's issuing rules (which exclude prefixes such as
    // QQ, HMRC's own specimen): a missed match is worse than an extra one to review.
    source: String.raw`\b[A-Z]{2}\s*\d{2}\s*\d{2}\s*\d{2}\s*[A-D]\b`,
  },
  ukPostcode: {
    region: "UK",
    label: "UK postcode",
    source: String.raw`\b(?:GIR\s*0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[ABD-HJLNP-UW-Z]{2})\b`,
  },

  // ---- US
  usSsn: {
    region: "US",
    label: "US Social Security number",
    // 123-45-6789, 123 45 6789 or 123456789; issuing rules checked in ssnValid.
    source: String.raw`${NO_DIGIT_BEFORE}${digits(3)}${SEP}${digits(2)}${SEP}${digits(4)}${NO_DIGIT_AFTER}`,
    validate: ssnValid,
  },
  usItin: {
    region: "US",
    label: "US ITIN (taxpayer ID, 9xx-xx-xxxx)",
    source: String.raw`${NO_DIGIT_BEFORE}9\s?\d\s?\d${SEP}${digits(2)}${SEP}${digits(4)}${NO_DIGIT_AFTER}`,
    validate: itinValid,
  },
  usEin: {
    region: "US",
    label: "US EIN (employer ID, 12-3456789)",
    // The dash is required: without it this is just any 9-digit number.
    source: String.raw`${NO_DIGIT_BEFORE}${digits(2)}\s?-\s?${digits(7)}${NO_DIGIT_AFTER}`,
  },
  usPhone: {
    region: "US",
    label: "US/Canada phone number",
    // Optional +1, area code (with or without brackets), exchange, line. NANP area
    // codes and exchanges never start with 0 or 1.
    source: String.raw`(?:\+\s?1${SEP}|\b1${SEP})?(?:\(\s*[2-9]\s?\d\s?\d\s*\)|${NO_DIGIT_BEFORE}[2-9]\s?\d\s?\d)${SEP}[2-9]\s?\d\s?\d${SEP}${digits(4)}${NO_DIGIT_AFTER}`,
  },
  usZip: {
    region: "US",
    label: "US ZIP code (after a state, e.g. CA 94105; or ZIP+4)",
    // A bare 5-digit number is far too common to redact blindly, so a plain ZIP
    // must follow a state abbreviation. ZIP+4 is distinctive enough on its own.
    source: String.raw`(?<=\b(?:${US_STATES})\.?,?\s{1,3})\d{5}(?:-\d{4})?\b|\b\d{5}-\d{4}\b`,
    flags: "gu", // state codes are upper case; "in 12345" is not Indiana
  },
  usRouting: {
    region: "US",
    label: "US bank routing number (ABA-checked)",
    source: String.raw`${NO_DIGIT_BEFORE}\d{9}${NO_DIGIT_AFTER}`,
    validate: abaValid,
  },
  usMbi: {
    region: "US",
    label: "US Medicare number (MBI)",
    source: String.raw`\b[1-9]${MBI_A}${MBI_AN}\d-?${MBI_A}${MBI_AN}\d-?${MBI_A}${MBI_A}\d\d\b`,
    flags: "gu",
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
 * Between the words of a literal term, any run of whitespace, dots, underscores
 * or hyphens is accepted — including none — so "John Smithers" also matches a
 * name wrapped across lines, "johnsmithers.org", "john.smithers@" and
 * "john_smithers". Names hide in URLs, emails and handles far more often than
 * they appear with exactly one space.
 * Within a word, a single space between letters is tolerated for letter-spaced text.
 * @throws {RedactionError} on an invalid user regex, naming which one.
 */
export function compilePatterns({ terms = [], regexes = [], presets = [] } = {}, options = {}) {
  const flags = "gu" + (options.caseSensitive ? "" : "i");
  const out = [];
  for (const raw of terms) {
    const t = String(raw).trim();
    if (!t) continue;
    // Within a word, allow one optional space between letters: letter-spaced text
    // (Word's "expanded" spacing, Tc in the PDF) extracts as "J o h n".
    const word = (w) => Array.from(w).map(escapeRegExp).join(String.raw`\s?`);
    const source = t.split(/\s+/).map(word).join(String.raw`[\s._-]*`);
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
    // Most presets match case-insensitively because scanned/OCR text is often
    // lower-cased; a preset can opt out where case carries meaning.
    out.push({ kind: "preset", label: p.label, re: new RegExp(p.source, p.flags ?? "gui"), validate: p.validate });
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
export function findMatches(pdf, patterns, { maxMatches = 10000, extraText = {} } = {}) {
  const results = [];
  const n = pdf.countPages();
  for (let p = 0; p < n; p++) {
    // Real text first; OCR text (if supplied for this page) searched separately so
    // a match never straddles the two.
    const sources = [{ source: "text", ...pageText(pdf.loadPage(p)) }];
    if (extraText[p]?.text) sources.push({ source: "ocr", text: extraText[p].text, quads: extraText[p].quads });
    for (const { source, text, quads } of sources) {
      for (const { label, re, validate } of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++; // guard against zero-length matches looping forever
            continue;
          }
          // Trim whitespace at the edges so boxes don't spill over neighbouring gaps.
          let start = m.index;
          let end = m.index + m[0].length;
          while (start < end && /\s/.test(text[start])) start++;
          while (end > start && /\s/.test(text[end - 1])) end--;
          if (start === end) continue;
          // Checksum-style validation: a failed check means it isn't this kind of number.
          if (validate && !validate(text.slice(start, end))) continue;
          const merged = mergeQuads(quads.slice(start, end));
          if (merged.length) {
            results.push({ page: p, label, source, text: m[0].replace(/\s+/g, " ").trim(), quads: merged });
          }
          if (results.length >= maxMatches) {
            throw new RedactionError(`More than ${maxMatches} matches — refine the pattern`, "TOO_MANY_MATCHES");
          }
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

/**
 * Rects (page space) whose rendered pixels are not a flat fill.
 * Rendered at 2x; each rect is inset by 1pt so anti-aliased edges don't count.
 */
export function nonUniformRegions(mupdf, pdf, pageIndex, rects, { tolerance = 48 } = {}) {
  const zoom = 2;
  const pix = pdf.loadPage(pageIndex).toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const px = pix.getPixels();
    const stride = pix.getStride();
    const [ox, oy, w, h] = [pix.getX(), pix.getY(), pix.getWidth(), pix.getHeight()];
    const bad = [];
    for (const r of rects) {
      const x0 = Math.max(0, Math.ceil((r[0] + 1) * zoom - ox));
      const y0 = Math.max(0, Math.ceil((r[1] + 1) * zoom - oy));
      const x1 = Math.min(w, Math.floor((r[2] - 1) * zoom - ox));
      const y1 = Math.min(h, Math.floor((r[3] - 1) * zoom - oy));
      if (x1 <= x0 || y1 <= y0) continue;
      let lo = 255;
      let hi = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * stride + x * 3;
          const v = (px[i] + px[i + 1] + px[i + 2]) / 3;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (hi - lo > tolerance) bad.push(r);
    }
    return bad;
  } finally {
    pix.destroy?.();
  }
}

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

  // 2b. OCR matches have no text to re-search; check the pixels instead. Each
  //     region must render as a flat fill (black box, or blank where content
  //     was removed) — any remaining ink means the scan wasn't cleared.
  const ocrByPage = new Map();
  for (const m of matches) {
    if (m.source !== "ocr") continue;
    const list = ocrByPage.get(m.page) ?? [];
    list.push(...m.quads.map(quadBBox));
    ocrByPage.set(m.page, list);
  }
  let ocrChecked = 0;
  for (const [p, rects] of ocrByPage) {
    if (p >= pdf.countPages()) continue;
    for (const bad of nonUniformRegions(mupdf, pdf, p, rects)) {
      failures.push(`Page ${p + 1}: scanned content still visible in a redacted area at ${bad.map(Math.round).join(",")}`);
    }
    ocrChecked += rects.length;
  }
  if (ocrChecked) {
    warnings.push(`${ocrChecked} OCR region${ocrChecked === 1 ? " was" : "s were"} checked by pixels, since scanned text can't be re-searched`);
  }

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
    // TextDecoder, not String.fromCharCode.apply: spreading 64K arguments overflows
    // the (smaller) stack of a browser worker on anything but tiny files.
    const latin = new TextDecoder("latin1").decode(raw).toLowerCase();
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
