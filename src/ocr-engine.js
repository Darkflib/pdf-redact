// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ocr-engine.js — browser glue for Tesseract. Loaded only when the user asks
// for OCR: the engine plus English model is several MB, served from this
// origin (never a CDN, so the CSP can stay closed).

import { ocrBlocksToText } from "./ocr.js";

const OCR_ZOOM = 3; // ≈216 dpi: good accuracy without huge bitmaps
const base = new URL(".", import.meta.url);
const asset = (p) => new URL(p, base).href;

let workerPromise = null;
let progressHandler = null;

/** Lazily create the Tesseract worker. Progress goes to whoever is listening now. */
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import("./vendor/tesseract/tesseract.esm.min.js");
      const Tesseract = mod.default ?? mod;
      return Tesseract.createWorker("eng", 1, {
        workerPath: asset("vendor/tesseract/worker.min.js"),
        corePath: asset("vendor/tesseract-core/"),
        langPath: asset("vendor/tessdata"),
        workerBlobURL: false, // a blob: worker would need a looser CSP
        cacheMethod: "none", // no IndexedDB; HTTP caching is enough
        gzip: true,
        logger: (m) => progressHandler?.(m),
      });
    })();
    // A failed load must not poison later attempts.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

/**
 * OCR one page of the document currently open in `engine` (our MuPDF worker).
 * @returns {{text, quads, lowConfidence}}
 */
export async function ocrPage(engine, index, { which = "source", onProgress } = {}) {
  progressHandler = onProgress ?? null;
  const worker = await getWorker();
  const r = await engine.call("render", { which, index, zoom: OCR_ZOOM });
  const { data } = await worker.recognize(new Blob([r.png], { type: "image/png" }), {}, { blocks: true });
  return ocrBlocksToText(data.blocks, r);
}

export async function terminateOcr() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate();
}
