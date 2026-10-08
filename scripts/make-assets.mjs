// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render the icon set and the social-share card from assets/ into src/.
// The PNGs are committed; re-run this only when assets/ changes:
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-assets.mjs
// Uses Playwright (already a dev dependency) so the output matches what a
// browser draws, fonts included.

import { chromium } from "@playwright/test";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const src = join(root, "src");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const svg = readFileSync(join(assets, "icon.svg"), "utf8");
  // Icons: plain renders of the SVG at each size the platforms ask for.
  for (const [name, size] of [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${
        // iOS rounds the corners itself and fills transparency with black, so the
        // touch icon is a full-bleed square.
        (name === "apple-touch-icon.png" ? svg.replace('rx="14"', 'rx="0"') : svg).replace("<svg ", `<svg width="${size}" height="${size}" `)
      }</body></html>`,
    );
    await page.screenshot({ path: join(src, name), omitBackground: true });
    await page.close();
    console.log(`wrote src/${name}`);
  }
  copyFileSync(join(assets, "icon.svg"), join(src, "favicon.svg"));

  // Social card at the size Open Graph / Slack / X prefer (1.91:1).
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto("file://" + join(assets, "og.html"));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(src, "og-image.png") });
  console.log("wrote src/og-image.png");
} finally {
  await browser.close();
}
