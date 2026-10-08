// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Link-preview and icon metadata. Crawlers (Slack, LinkedIn…) don't run JS and
// only follow absolute URLs, so a typo here silently degrades every shared link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const html = readFileSync(SRC + "index.html", "utf8");
const CANONICAL = "https://darkflib.github.io/pdf-redact/";

const meta = (attr, name) =>
  html.match(new RegExp(`<meta ${attr}="${name.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`))?.[1];

/** PNG width/height from the IHDR chunk. */
function pngSize(file) {
  const b = readFileSync(SRC + file);
  assert.equal(b.toString("latin1", 1, 4), "PNG", `${file} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("Open Graph and Twitter tags are present", () => {
  for (const p of ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:alt"]) {
    assert.ok(meta("property", p), `missing ${p}`);
  }
  for (const n of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
    assert.ok(meta("name", n), `missing ${n}`);
  }
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
});

test("preview URLs are absolute, https, and under the canonical URL", () => {
  assert.ok(html.includes(`<link rel="canonical" href="${CANONICAL}">`));
  assert.equal(meta("property", "og:url"), CANONICAL);
  for (const url of [meta("property", "og:image"), meta("name", "twitter:image")]) {
    assert.ok(url.startsWith(CANONICAL), url);
  }
});

test("og:image exists with the declared 1200×630 size", () => {
  const file = new URL(meta("property", "og:image")).pathname.split("/").pop();
  assert.deepEqual(pngSize(file), [1200, 630]);
  assert.equal(meta("property", "og:image:width"), "1200");
  assert.equal(meta("property", "og:image:height"), "630");
});

test("every linked icon exists, PNGs at their stated sizes", () => {
  for (const [, href] of html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)) {
    assert.ok(existsSync(SRC + href), `${href} missing`);
  }
  assert.deepEqual(pngSize("favicon-32.png"), [32, 32]);
  assert.deepEqual(pngSize("apple-touch-icon.png"), [180, 180]);
  const manifest = JSON.parse(readFileSync(SRC + "manifest.webmanifest", "utf8"));
  for (const icon of manifest.icons) {
    assert.ok(existsSync(SRC + icon.src), `${icon.src} missing`);
    if (icon.type === "image/png") assert.deepEqual(pngSize(icon.src), icon.sizes.split("x").map(Number));
  }
});

test("the CSP still allows the manifest and nothing extra", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /manifest-src 'self'/);
  assert.doesNotMatch(csp, /https?:/, "no third-party origins");
});
