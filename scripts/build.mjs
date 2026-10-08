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
