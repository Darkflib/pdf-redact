// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assemble dist/ for GitHub Pages: app sources + a vendored copy of MuPDF.js.
// MuPDF is served from this origin (not a CDN) so the CSP can forbid all
// third-party loads, and the exact build that was tested is the one deployed.

import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const mupdfDist = join(root, "node_modules", "mupdf", "dist");

try {
  if (!existsSync(mupdfDist)) throw new Error("node_modules/mupdf missing — run `npm ci` first");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "vendor", "mupdf"), { recursive: true });

  cpSync(join(root, "src"), dist, { recursive: true });
  for (const f of ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"]) {
    cpSync(join(mupdfDist, f), join(dist, "vendor", "mupdf", f));
  }
  // OCR (loaded only on demand): tesseract.js, the LSTM-only WASM cores (the
  // loader picks one by CPU feature), and the compact English model.
  const nm = (...p) => join(root, "node_modules", ...p);
  const vend = (...p) => join(dist, "vendor", ...p);
  mkdirSync(vend("tesseract"), { recursive: true });
  mkdirSync(vend("tesseract-core"), { recursive: true });
  mkdirSync(vend("tessdata"), { recursive: true });
  mkdirSync(vend("fflate"), { recursive: true });
  for (const f of ["tesseract.esm.min.js", "worker.min.js"]) cpSync(nm("tesseract.js", "dist", f), vend("tesseract", f));
  cpSync(nm("tesseract.js", "LICENSE.md"), vend("tesseract", "LICENSE.txt"));
  for (const f of ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) {
    cpSync(nm("tesseract.js-core", f), vend("tesseract-core", f));
  }
  cpSync(nm("tesseract.js-core", "LICENSE"), vend("tesseract-core", "LICENSE.txt"));
  cpSync(nm("@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), vend("tessdata", "eng.traineddata.gz"));
  writeFileSync(vend("tessdata", "README.txt"), "eng.traineddata from tesseract-ocr/tessdata_best (int), Apache-2.0, via @tesseract.js-data/eng\n");
  // Zip writer for batch downloads.
  cpSync(nm("fflate", "esm", "browser.js"), vend("fflate", "browser.js"));
  cpSync(nm("fflate", "LICENSE"), vend("fflate", "LICENSE.txt"));

  // AGPL: ship the licence and point at the corresponding source.
  cpSync(join(root, "LICENSE"), join(dist, "LICENSE.txt"));
  cpSync(join(root, "node_modules", "mupdf", "LICENSE"), join(dist, "vendor", "mupdf", "LICENSE.txt"));
  const version = JSON.parse(readFileSync(join(root, "node_modules", "mupdf", "package.json"), "utf8")).version;
  writeFileSync(join(dist, "vendor", "mupdf", "VERSION"), `mupdf ${version}\nhttps://github.com/ArtifexSoftware/mupdf.js\n`);
  writeFileSync(join(dist, ".nojekyll"), ""); // serve files as-is
  console.log(`built dist/ with mupdf ${version}`);
} catch (e) {
  console.error(`build failed: ${e.message}`);
  process.exit(1);
}
