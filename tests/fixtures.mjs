// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Programmatic test fixtures. Each fixture plants sensitive data in a specific
// place a naive redactor would miss. Built with MuPDF's low-level object API so the
// suite has no binary fixtures and no Python dependency.

import * as mupdf from "mupdf";

export const PAGE_W = 595;
export const PAGE_H = 842;

/** PDF string literal escaping for content streams. */
function pdfStr(s) {
  return "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}

/**
 * Text line spec → content-stream fragment. `top` is the top-down y of the baseline
 * region (page space), converted here to PDF's bottom-up user space.
 */
function textOp({ x, top, text, size = 12, mode = 0, rgb = [0, 0, 0], charSpacing = 0 }) {
  const y = PAGE_H - top - size; // baseline roughly one em below the top
  return `BT /F1 ${size} Tf ${mode} Tr ${charSpacing} Tc ${rgb.join(" ")} rg ${x} ${y} Td ${pdfStr(text)} Tj ET\n`;
}

/** Rect in page space (top-down) → PDF user-space "x y w h". */
export function userRect([x0, y0, x1, y1]) {
  return `${x0} ${PAGE_H - y1} ${x1 - x0} ${y1 - y0}`;
}

function newDoc() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  return { doc, font };
}

function addPage(doc, resources, content, rotate = 0) {
  const pageObj = doc.addPage([0, 0, PAGE_W, PAGE_H], rotate, resources, content);
  doc.insertPage(-1, pageObj);
}

function solidImage(doc, w, h, [r, g, b]) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let i = 0; i < px.length; i += 3) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  return doc.addImage(new mupdf.Image(pix));
}

function save(doc, opts = "compress") {
  return doc.saveToBuffer(opts).asUint8Array().slice();
}

// Regions referenced by tests (page space, top-down).
export const IMAGE_RECT = [72, 300, 272, 400]; // red raster image, page 1
export const VECTOR_RECT = [320, 300, 470, 400]; // blue filled path, page 1

/**
 * The kitchen-sink fixture.
 * Page 1: visible PII, invisible (Tr 3) OCR-style text, white-on-white text,
 *         a red image, a blue vector box, a comment, a form field.
 * Page 2: upper-case repeat and a name split across two lines.
 * Document: Info, XMP, outline, attachment, structure tree with /Alt.
 */
export function kitchenSink() {
  const { doc, font } = newDoc();
  const img = solidImage(doc, 40, 20, [220, 30, 30]);
  const res = doc.addObject({ Font: { F1: font }, XObject: { Im1: img } });

  const p1 =
    textOp({ x: 72, top: 60, text: "Patient: John Smithers, DOB 01/02/1970" }) +
    textOp({ x: 72, top: 80, text: "Email: john.smithers@example.com  Phone: 07700 900123" }) +
    textOp({ x: 72, top: 100, text: "NI: QQ 12 34 56 C  Postcode: DE74 2AB" }) +
    textOp({ x: 72, top: 120, text: "Reference ACME-4471 is confidential." }) +
    textOp({ x: 72, top: 140, text: "Keep this sentence intact." }) +
    textOp({ x: 72, top: 160, text: "Hidden OCR layer secret", mode: 3 }) +
    textOp({ x: 72, top: 180, text: "Whitewashed secret", rgb: [1, 1, 1] }) +
    // Raster image and vector art.
    `q ${IMAGE_RECT[2] - IMAGE_RECT[0]} 0 0 ${IMAGE_RECT[3] - IMAGE_RECT[1]} ${IMAGE_RECT[0]} ${PAGE_H - IMAGE_RECT[3]} cm /Im1 Do Q\n` +
    `q 0 0 1 rg ${userRect(VECTOR_RECT)} re f Q\n`;
  addPage(doc, res, p1);

  const p2 =
    textOp({ x: 72, top: 60, text: "Page two mentions JOHN SMITHERS again." }) +
    textOp({ x: 72, top: 80, text: "The signatory was John" }) +
    textOp({ x: 72, top: 96, text: "Smithers, in person." });
  addPage(doc, res, p2);

  // Info dictionary + XMP.
  doc.setMetaData("info:Title", "Report on John Smithers");
  doc.setMetaData("info:Author", "Jane Secretary");
  doc.setMetaData("info:Subject", "NI QQ123456C");
  const root = doc.getTrailer().get("Root");
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'><rdf:Description " +
    "xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:creator>Smithers XMP</dc:creator>" +
    "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end='w'?>";
  root.put("Metadata", doc.addStream(xmp, { Type: doc.newName("Metadata"), Subtype: doc.newName("XML") }));

  // Bookmark.
  doc.outlineIterator().insert({ title: "John Smithers summary", uri: "#page=1" });

  // Attachment.
  const now = new Date();
  const fs = doc.addEmbeddedFile("notes.txt", "text/plain", "Attachment about John Smithers", now, now);
  doc.insertEmbeddedFile("notes.txt", fs);

  // Structure tree carrying alt text.
  const sr = doc.addObject({
    Type: doc.newName("StructTreeRoot"),
    K: doc.addObject({ Type: doc.newName("StructElem"), S: doc.newName("Figure"), Alt: doc.newString("Photo of John Smithers") }),
  });
  root.put("StructTreeRoot", sr);
  root.put("MarkInfo", { Marked: true });

  // Comment annotation.
  const page = doc.loadPage(0);
  const note = page.createAnnotation("Text");
  note.setRect([500, 60, 520, 80]);
  note.setContents("Comment: Smithers is the claimant");
  note.update();

  // Form field (widget) holding a value.
  const field = doc.addObject({
    Type: doc.newName("Annot"),
    Subtype: doc.newName("Widget"),
    FT: doc.newName("Tx"),
    T: doc.newString("claimant"),
    V: doc.newString("John Smithers form value"),
    Rect: [72, 600, 300, 620],
    P: doc.findPage(0),
  });
  doc.findPage(0).get("Annots").push(field);
  root.put("AcroForm", { Fields: [field] });

  return save(doc);
}

/** Text inside a hidden optional-content group (layer). */
export function hiddenLayer() {
  const { doc, font } = newDoc();
  const ocg = doc.addObject({ Type: doc.newName("OCG"), Name: doc.newString("Secret layer") });
  const res = doc.addObject({ Font: { F1: font }, Properties: { oc1: ocg } });
  const content =
    textOp({ x: 72, top: 60, text: "Visible line." }) +
    "/OC /oc1 BDC\n" +
    textOp({ x: 72, top: 80, text: "Layer secret Smithers" }) +
    "EMC\n";
  addPage(doc, res, content);
  doc.getTrailer().get("Root").put("OCProperties", { OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } });
  return save(doc);
}

/** A /Rotate 90 page — page space differs from user space. */
export function rotated() {
  const { doc, font } = newDoc();
  const res = doc.addObject({ Font: { F1: font } });
  addPage(doc, res, textOp({ x: 72, top: 60, text: "Rotated secret Smithers here" }), 90);
  return save(doc);
}

/** Kitchen sink, AES-256 encrypted with user password "pw". */
export function encrypted() {
  const src = mupdf.Document.openDocument(kitchenSink(), "application/pdf").asPDF();
  return save(src, "encrypt=aes-256,user-password=pw,owner-password=owner");
}

/** Many pages, for a crude performance guard. */
export function manyPages(n = 50) {
  const { doc, font } = newDoc();
  const res = doc.addObject({ Font: { F1: font } });
  for (let i = 0; i < n; i++) {
    addPage(doc, res, textOp({ x: 72, top: 60, text: `Page ${i + 1} for John Smithers, ref ACME-${1000 + i}` }));
  }
  return save(doc);
}

/**
 * What Word-exported CVs look like: names inside URLs and emails, and a phone
 * number set with wide character spacing (Tc), which text extraction can turn
 * into "0 7 9 5 0 …".
 */
export function wordStyle() {
  const { doc, font } = newDoc();
  const res = doc.addObject({ Font: { F1: font } });
  const content =
    textOp({ x: 72, top: 60, text: "Mobile: 07950 892038 (inc signal)", charSpacing: 4 }) +
    textOp({ x: 72, top: 80, text: "Web: johnsmithers.org / smithersj.com" }) +
    textOp({ x: 72, top: 100, text: "Email: John_Smithers@example.com, handle john-smithers" }) +
    textOp({ x: 72, top: 120, text: "Unrelated: Smith and Sons Ltd" });
  addPage(doc, res, content);
  return save(doc);
}

/**
 * A "scanned" page: real text rendered to a bitmap at ~216 dpi, then placed as
 * the only content of a new page. There is no text layer, so only OCR or a
 * drawn box can find anything.
 */
export const SCAN_ZOOM = 3;
export function scanned() {
  const { doc: src, font } = newDoc();
  const res = src.addObject({ Font: { F1: font } });
  addPage(
    src,
    res,
    textOp({ x: 72, top: 80, text: "Scanned letter for John Smithers", size: 16 }) +
      textOp({ x: 72, top: 120, text: "Telephone 07700 900123", size: 16 }) +
      textOp({ x: 72, top: 160, text: "Keep this line intact", size: 16 }),
  );
  const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(SCAN_ZOOM, SCAN_ZOOM), mupdf.ColorSpace.DeviceGray, false, true);

  const { doc } = newDoc();
  const img = doc.addImage(new mupdf.Image(pix));
  const pres = doc.addObject({ XObject: { Scan: img } });
  addPage(doc, pres, `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Scan Do Q\n`);
  return save(doc);
}

/** US identifiers, plus decoys that look numeric but must NOT be redacted. */
export function usStyle() {
  const { doc, font } = newDoc();
  const res = doc.addObject({ Font: { F1: font } });
  const content =
    textOp({ x: 72, top: 60, text: "Employee: Jane Q. Public" }) +
    textOp({ x: 72, top: 80, text: "SSN: 123-45-6789   ITIN: 912-70-1234" }) +
    textOp({ x: 72, top: 100, text: "Phone: (415) 555-2671   EIN: 12-3456789" }) +
    textOp({ x: 72, top: 120, text: "Address: 1 Market St, San Francisco, CA 94105" }) +
    textOp({ x: 72, top: 140, text: "Card: 4111 1111 1111 1111   Routing: 021000021" }) +
    textOp({ x: 72, top: 160, text: "Medicare: 1EG4-TE5-MK73   DOB: March 3, 1980" }) +
    textOp({ x: 72, top: 180, text: "Invoice 000123456, order total 99999, keep this sentence intact." });
  addPage(doc, res, content);
  return save(doc);
}
