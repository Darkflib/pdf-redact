// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end tests: the real page, real worker, real WASM, in Chromium.
// Downloads are checked in Node with pdf.js, independently of the app.

import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as mupdf from "mupdf";
import * as fx from "./fixtures.mjs";

const tmp = mkdtempSync(join(tmpdir(), "redact-e2e-"));
const fixture = (name, bytes) => {
  const p = join(tmp, `${name}.pdf`);
  writeFileSync(p, bytes);
  return p;
};
const KITCHEN = fixture("kitchen-sink", fx.kitchenSink());
const ENCRYPTED = fixture("encrypted", fx.encrypted());

async function extractText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out += tc.items.map((t) => t.str).join(" ") + "\n";
  }
  await doc.loadingTask.destroy();
  return out.toLowerCase();
}

function pixelAt(bytes, [x, y]) {
  const d = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const pix = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const i = Math.round(y) * pix.getStride() + Math.round(x) * 3;
  const px = pix.getPixels();
  return [px[i], px[i + 1], px[i + 2]];
}

/** Collect console errors, CSP violations and every request URL. */
async function instrument(page) {
  const seen = { errors: [], csp: [], requests: [] };
  page.on("console", (m) => m.type() === "error" && seen.errors.push(m.text()));
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("request", (r) => seen.requests.push(r.url()));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return seen;
}

async function openKitchenSink(page) {
  await page.goto("/");
  await page.setInputFiles("#file", KITCHEN);
  await expect(page.locator("#file-status")).toContainText("2 pages");
  await expect(page.locator(".page img").first()).toHaveAttribute("src", /^blob:/);
}

/** Drag a box over a page-space rect on page 0. */
async function drawBox(page, [x0, y0, x1, y1]) {
  const overlay = page.locator('.page[data-index="0"] .overlay');
  // Scroll the viewer so the target rect is on screen; mouse events off-screen miss.
  await overlay.evaluate((el, top) => {
    const host = el.closest(".pages");
    host.scrollTop += el.getBoundingClientRect().top - host.getBoundingClientRect().top + top - 40;
  }, (y0 / fx.PAGE_H) * (await overlay.boundingBox()).height);
  const box = await overlay.boundingBox();
  const sx = box.width / fx.PAGE_W;
  const sy = box.height / fx.PAGE_H;
  await page.mouse.move(box.x + x0 * sx, box.y + y0 * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + ((x0 + x1) / 2) * sx, box.y + ((y0 + y1) / 2) * sy, { steps: 4 });
  await page.mouse.move(box.x + x1 * sx, box.y + y1 * sy, { steps: 4 });
  await page.mouse.up();
}

async function redactAndDownload(page) {
  await page.click("#apply");
  await expect(page.locator("#report .status")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  return readFileSync(await download.path());
}

test("loads cleanly: no errors, no CSP violations, engine ready", async ({ page }) => {
  const seen = await instrument(page);
  await openKitchenSink(page);
  expect(seen.errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test("full flow: search + drawn box → verified, downloaded, and independently clean", async ({ page, baseURL }) => {
  const seen = await instrument(page);
  await openKitchenSink(page);

  await page.fill("#terms", "Smithers\nACME-4471");
  await page.getByLabel("Email address").check();
  await page.click("#find");
  await expect(page.locator(".matches details")).toHaveCount(3);
  await expect(page.locator(".mark-match").first()).toBeVisible();

  await drawBox(page, fx.VECTOR_RECT);
  await expect(page.locator("#boxes li")).toHaveCount(1);

  const bytes = await redactAndDownload(page);
  await expect(page.locator("#report .status")).toHaveAttribute("data-kind", "ok");
  await expect(page.locator("#tab-output")).toBeEnabled();

  const text = await extractText(bytes);
  for (const s of ["smithers", "acme-4471", "@example.com"]) expect(text).not.toContain(s);
  expect(text).toContain("keep this sentence intact.");
  // The drawn box landed where intended: vector art there is now a black box.
  const c = [(fx.VECTOR_RECT[0] + fx.VECTOR_RECT[2]) / 2, (fx.VECTOR_RECT[1] + fx.VECTOR_RECT[3]) / 2];
  expect(pixelAt(bytes, c)).toEqual([0, 0, 0]);

  // Nothing left the origin.
  const origin = new URL(baseURL).origin;
  const foreign = seen.requests.filter((u) => !u.startsWith(origin) && !u.startsWith("blob:") && !u.startsWith("data:"));
  expect(foreign).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("unticking a match keeps that text", async ({ page }) => {
  await openKitchenSink(page);
  await page.fill("#terms", "confidential");
  await page.click("#find");
  await page.locator(".matches li input[type=checkbox]").first().uncheck();
  const bytes = await redactAndDownload(page);
  expect(await extractText(bytes)).toContain("confidential");
});

test("a box can be removed again", async ({ page }) => {
  await openKitchenSink(page);
  await drawBox(page, [100, 500, 200, 550]);
  await expect(page.locator(".mark-box:not(.ghost)")).toHaveCount(1);
  await page.locator(".mark-box .remove").click();
  await expect(page.locator(".mark-box")).toHaveCount(0);
  await expect(page.locator("#boxes li")).toHaveCount(0);
});

test("tiny accidental clicks do not create boxes", async ({ page }) => {
  await openKitchenSink(page);
  const box = await page.locator('.page[data-index="0"] .overlay').boundingBox();
  await page.mouse.click(box.x + 200, box.y + 500);
  await expect(page.locator("#boxes li")).toHaveCount(0);
});

test("encrypted PDF: password prompt, wrong then right password", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#file", ENCRYPTED);
  await expect(page.locator("#pw-row")).toBeVisible();
  await page.fill("#password", "nope");
  await page.click("#pw-go");
  await expect(page.locator("#file-status")).toContainText("wrong");
  await page.fill("#password", "pw");
  await page.click("#pw-go");
  await expect(page.locator("#file-status")).toContainText("2 pages");

  await page.fill("#terms", "Smithers");
  await page.click("#find");
  const bytes = await redactAndDownload(page);
  expect(await extractText(bytes)).not.toContain("smithers"); // and it opened without a password
});

test("invalid regex is reported, not thrown", async ({ page }) => {
  const seen = await instrument(page);
  await openKitchenSink(page);
  await page.fill("#regexes", "(unclosed");
  await page.click("#find");
  await expect(page.locator("#matches .status")).toContainText("Invalid regular expression");
  expect(seen.errors.filter((e) => !e.includes("[worker]"))).toEqual([]);
});

test("changing a search invalidates a previous result", async ({ page }) => {
  await openKitchenSink(page);
  await page.fill("#terms", "Smithers");
  await page.click("#find");
  await page.click("#apply");
  await expect(page.locator("#download")).toBeVisible();
  await page.click("#find");
  await expect(page.locator("#download")).toBeHidden();
  await expect(page.locator("#tab-output")).toBeDisabled();
});

test("non-PDF file gives a clear error", async ({ page }) => {
  await page.goto("/");
  const p = join(tmp, "not.pdf");
  writeFileSync(p, "hello, I am not a PDF");
  await page.setInputFiles("#file", p);
  await expect(page.locator("#file-status")).toHaveAttribute("data-kind", "error");
});
