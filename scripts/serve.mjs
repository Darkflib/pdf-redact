// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal static server for local use and e2e tests. Mirrors GitHub Pages closely
// enough: correct MIME types (application/wasm matters), no special headers.
// Usage: node scripts/serve.mjs <dir> <port>

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = normalize(join(dir, decodeURIComponent(url.pathname)));
    // Refuse path traversal outside the served directory.
    if (path !== dir && !path.startsWith(dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (e.code !== "ENOENT") console.error(e);
    res.writeHead(e.code === "ENOENT" ? 404 : 500).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
