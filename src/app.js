// SPDX-License-Identifier: AGPL-3.0-or-later
//
// app.js — UI. Owns no PDF logic; everything goes through the worker.

import { PRESETS, DEFAULT_OPTIONS } from "./core.js";
import { ocrPage } from "./ocr-engine.js";
import { zipSync } from "./vendor/fflate/browser.js";

const $ = (id) => document.getElementById(id);
const log = (...a) => console.info("[redactor]", ...a);

const FIND_TIMEOUT_MS = 20000; // kills the worker if a user regex runs away
const RENDER_ZOOM = Math.min(3, Math.max(1.5, (window.devicePixelRatio || 1) * 1.25));
const MIN_BOX_PT = 2;

// ---------------------------------------------------------------- worker client

class Engine {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.addEventListener("error", (e) => reject(new Error(e.message || "Worker failed to load")), { once: true });
      this.worker.addEventListener("message", (e) => e.data?.type === "ready" && resolve(), { once: true });
    });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.ok) p.resolve(data.result);
      else p.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
    };
  }

  /** Terminate and replace the worker, failing everything in flight. */
  restart(reason) {
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(reason), { code: "TIMEOUT" }));
    }
    this.pending.clear();
    this.spawn();
  }

  async call(type, payload = {}, { transfer = [], timeout = 0 } = {}) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeout) entry.timer = setTimeout(() => this.restart(`${type} took longer than ${timeout / 1000}s`), timeout);
      this.pending.set(id, entry);
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }
}

// ---------------------------------------------------------------- state

const state = {
  fileName: "",
  bytes: null, // kept on the main thread only so the worker can be restarted
  password: "",
  pages: [], // [{bounds}]
  outPages: [],
  matches: [], // [{id, page, label, text, quads, enabled}]
  boxes: [], // [{id, page, rect}]
  view: "source",
  downloadUrl: null,
  files: [], // every PDF the user opened, for batch mode
  current: -1, // index into files of the one being reviewed
  ocr: {}, // page index → {text, quads, lowConfidence}, from Tesseract
  batchUrls: [],
  renderCache: { source: new Map(), output: new Map() },
};
let nextId = 1;
const engine = new Engine();

// ---------------------------------------------------------------- options

const OPTION_IDS = Object.keys(DEFAULT_OPTIONS).filter((k) => k !== "caseSensitive");
/** Options that change the prepared document, so changing them means reopening. */
const PREP_OPTIONS = new Set(["revealHiddenLayers", "removeAnnotations"]);

function readOptions() {
  const o = { caseSensitive: $("opt-case").checked };
  for (const k of OPTION_IDS) {
    const el = $(`opt-${k}`);
    o[k] = el.type === "checkbox" ? el.checked : el.value;
  }
  return o;
}

// ---------------------------------------------------------------- status helpers

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.dataset.kind = kind;
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

// ---------------------------------------------------------------- open

/** Accept one or many files; review the first, keep the rest for batch mode. */
async function openFiles(list) {
  const pdfs = [...(list ?? [])].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!pdfs.length) {
    setStatus($("file-status"), "No PDF files in that selection.", "error");
    return;
  }
  state.files = pdfs;
  clearBatch();
  renderFileList();
  await openFile(0);
}

function renderFileList() {
  const ul = $("files");
  ul.hidden = state.files.length < 2;
  $("batch").hidden = state.files.length < 2;
  ul.replaceChildren(
    ...state.files.map((f, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.name;
      b.title = f.name;
      b.setAttribute("aria-current", String(i === state.current));
      b.addEventListener("click", () => i !== state.current && openFile(i));
      li.append(b);
      return li;
    }),
  );
}

async function openFile(index) {
  const file = state.files[index];
  if (!file) return;
  state.current = index;
  renderFileList();
  if (file.size > 200 * 1024 * 1024) {
    setStatus($("file-status"), "That file is over 200 MB, which is too large to handle in the browser.", "error");
    return;
  }
  resetDocState();
  state.fileName = file.name.replace(/\.pdf$/i, "");
  state.bytes = new Uint8Array(await file.arrayBuffer());
  state.password = "";
  await loadIntoEngine();
}

async function loadIntoEngine() {
  const status = $("file-status");
  setStatus(status, "Opening…");
  try {
    const { pages } = await engine.call("open", {
      bytes: state.bytes.slice(),
      password: state.password,
      options: readOptions(),
    });
    $("pw-row").hidden = true;
    state.pages = pages;
    setStatus(status, `${state.fileName}.pdf — ${pages.length} page${pages.length === 1 ? "" : "s"}`, "ok");
    $("find").disabled = false;
    $("apply").disabled = false;
    populateTextView();
    renderOcrInfo();
    showView("source");
  } catch (e) {
    if (e.code === "NEEDS_PASSWORD" || e.code === "BAD_PASSWORD") {
      $("pw-row").hidden = false;
      $("password").focus();
      setStatus(status, e.code === "BAD_PASSWORD" ? "That password is wrong." : "This PDF needs a password to open.", "error");
    } else {
      setStatus(status, e.message, "error");
    }
    log("open failed", e);
  }
}

function resetDocState() {
  state.ocr = {};
  setStatus($("ocr-status"), "");
  state.matches = [];
  state.boxes = [];
  state.pages = [];
  state.outPages = [];
  clearOutput();
  for (const c of Object.values(state.renderCache)) {
    for (const url of c.values()) URL.revokeObjectURL(url);
    c.clear();
  }
  renderMatches();
  renderBoxList();
}

function clearOutput() {
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = null;
  for (const url of state.renderCache.output.values()) URL.revokeObjectURL(url);
  state.renderCache.output.clear();
  state.outPages = [];
  $("download").hidden = true;
  $("override-row").hidden = true;
  $("override").checked = false;
  $("report").replaceChildren();
  $("tab-output").disabled = true;
  if (state.view === "output") showView("source");
}

// ---------------------------------------------------------------- viewer

let observer = null;

function showView(view) {
  state.view = view;
  $("tab-source").setAttribute("aria-selected", String(view === "source"));
  $("tab-output").setAttribute("aria-selected", String(view === "output"));
  const pages = view === "source" ? state.pages : state.outPages;
  const host = $("pages");
  host.replaceChildren();
  observer?.disconnect();
  observer = new IntersectionObserver(onVisible, { root: host, rootMargin: "800px 0px" });

  pages.forEach(({ bounds }, i) => {
    const [x0, y0, x1, y1] = bounds;
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.dataset.index = String(i);
    wrap.style.aspectRatio = `${x1 - x0} / ${y1 - y0}`;
    const img = document.createElement("img");
    img.alt = `Page ${i + 1}`;
    img.draggable = false;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const label = document.createElement("span");
    label.className = "pageno";
    label.textContent = String(i + 1);
    wrap.append(img, overlay, label);
    host.append(wrap);
    if (view === "source") attachDrawing(overlay, i);
    observer.observe(wrap);
  });
  if (view === "source") drawOverlays();
}

async function onVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const wrap = entry.target;
    observer.unobserve(wrap);
    const index = Number(wrap.dataset.index);
    const view = state.view;
    const cache = state.renderCache[view];
    try {
      let url = cache.get(index);
      if (!url) {
        const r = await engine.call("render", { which: view, index, zoom: RENDER_ZOOM });
        url = URL.createObjectURL(new Blob([r.png], { type: "image/png" }));
        cache.set(index, url);
      }
      if (state.view === view) wrap.querySelector("img").src = url;
    } catch (e) {
      log("render failed", index, e);
      wrap.classList.add("failed");
    }
  }
}

/** Page-space rect → CSS percentages within the page element. */
function placeRect(el, page, [rx0, ry0, rx1, ry1]) {
  const [x0, y0, x1, y1] = state.pages[page].bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  el.style.left = `${((rx0 - x0) / w) * 100}%`;
  el.style.top = `${((ry0 - y0) / h) * 100}%`;
  el.style.width = `${((rx1 - rx0) / w) * 100}%`;
  el.style.height = `${((ry1 - ry0) / h) * 100}%`;
}

function quadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function drawOverlays() {
  if (state.view !== "source") return;
  const overlays = [...document.querySelectorAll(".page .overlay")];
  overlays.forEach((o) => o.querySelectorAll(".mark-match, .mark-box").forEach((n) => n.remove()));
  for (const m of state.matches) {
    const ov = overlays[m.page];
    if (!ov) continue;
    for (const q of m.quads) {
      const el = document.createElement("div");
      el.className = "mark-match" + (m.enabled ? "" : " off");
      el.dataset.match = String(m.id);
      el.title = `${m.label}: ${m.text}`;
      placeRect(el, m.page, quadRect(q));
      ov.append(el);
    }
  }
  for (const b of state.boxes) {
    const ov = overlays[b.page];
    if (!ov) continue;
    const el = document.createElement("div");
    el.className = "mark-box";
    el.dataset.box = String(b.id);
    placeRect(el, b.page, b.rect);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "remove";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove box on page ${b.page + 1}`);
    x.addEventListener("pointerdown", (e) => e.stopPropagation());
    x.addEventListener("click", () => removeBox(b.id));
    el.append(x);
    ov.append(el);
  }
}

// ---------------------------------------------------------------- drawing boxes

function attachDrawing(overlay, pageIndex) {
  let start = null;
  let ghost = null;

  const toPage = (e) => {
    const r = overlay.getBoundingClientRect();
    const [x0, y0, x1, y1] = state.pages[pageIndex].bounds;
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)];
  };

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    start = toPage(e);
    ghost = document.createElement("div");
    ghost.className = "mark-box ghost";
    overlay.append(ghost);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = toPage(e);
    placeRect(ghost, pageIndex, [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])]);
  });
  const finish = (e) => {
    if (!start) return;
    const p = toPage(e);
    const rect = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])];
    ghost?.remove();
    start = ghost = null;
    if (rect[2] - rect[0] < MIN_BOX_PT || rect[3] - rect[1] < MIN_BOX_PT) return;
    state.boxes.push({ id: nextId++, page: pageIndex, rect: rect.map((v) => Math.round(v * 100) / 100) });
    invalidateOutput();
    drawOverlays();
    renderBoxList();
  };
  overlay.addEventListener("pointerup", finish);
  overlay.addEventListener("pointercancel", () => {
    ghost?.remove();
    start = ghost = null;
  });
}

function removeBox(id) {
  state.boxes = state.boxes.filter((b) => b.id !== id);
  invalidateOutput();
  drawOverlays();
  renderBoxList();
}

function renderBoxList() {
  const ul = $("boxes");
  ul.replaceChildren();
  for (const b of state.boxes) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    const [x0, y0, x1, y1] = b.rect;
    span.textContent = `Page ${b.page + 1} · ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} pt`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => removeBox(b.id));
    li.append(span, del);
    ul.append(li);
  }
}

// ---------------------------------------------------------------- find

const lines = (id) => $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
const selectedPresets = () => [...document.querySelectorAll("#presets input:checked")].map((i) => i.value);

function searchPayload() {
  return { terms: lines("terms"), regexes: lines("regexes"), presets: selectedPresets() };
}

async function find() {
  const btn = $("find");
  const payload = searchPayload();
  if (!payload.terms.length && !payload.regexes.length && !payload.presets.length) {
    renderMatches("Enter something to search for.");
    return;
  }
  busy(btn, true, "Searching…");
  // A result produced mid-search would be invalidated when the search lands.
  $("apply").disabled = true;
  try {
    const { matches } = await engine.call("find", { ...payload, extraText: state.ocr }, { timeout: FIND_TIMEOUT_MS });
    state.matches = matches.map((m) => ({ ...m, id: nextId++, enabled: true }));
    invalidateOutput();
    renderMatches();
    drawOverlays();
  } catch (e) {
    if (e.code === "TIMEOUT") {
      renderMatches(`${e.message}. A regular expression is probably too expensive; simplify it.`);
      await loadIntoEngine(); // the worker was replaced; reload the document
    } else {
      renderMatches(e.message);
    }
    log("find failed", e);
  } finally {
    busy(btn, false);
    $("apply").disabled = !state.pages.length;
  }
}

function renderMatches(error) {
  const host = $("matches");
  host.replaceChildren();
  if (error) {
    const p = document.createElement("p");
    p.className = "status";
    p.dataset.kind = "error";
    p.textContent = error;
    host.append(p);
    return;
  }
  if (!state.matches.length) {
    if (state.pages.length && (lines("terms").length || lines("regexes").length || selectedPresets().length)) {
      const p = document.createElement("p");
      p.className = "status";
      p.textContent = textlessPages().length
        ? "No matches. Some pages have no text; run OCR below, or draw boxes over them."
        : "No matches.";
      host.append(p);
    }
    return;
  }
  const groups = Map.groupBy ? Map.groupBy(state.matches, (m) => m.label) : groupBy(state.matches);
  for (const [label, items] of groups) {
    const det = document.createElement("details");
    det.open = groups.size <= 3;
    const sum = document.createElement("summary");
    const all = document.createElement("input");
    all.type = "checkbox";
    all.checked = items.every((m) => m.enabled);
    all.indeterminate = !all.checked && items.some((m) => m.enabled);
    all.setAttribute("aria-label", `Toggle all ${label}`);
    all.addEventListener("click", (e) => e.stopPropagation());
    all.addEventListener("change", () => {
      items.forEach((m) => (m.enabled = all.checked));
      invalidateOutput();
      renderMatches();
      drawOverlays();
    });
    const name = document.createElement("span");
    name.textContent = `${label} `;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(items.length);
    sum.append(all, name, count);
    det.append(sum);
    const ul = document.createElement("ul");
    for (const m of items) {
      const li = document.createElement("li");
      const lab = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = m.enabled;
      cb.addEventListener("change", () => {
        m.enabled = cb.checked;
        invalidateOutput();
        renderMatches();
        drawOverlays();
      });
      const t = document.createElement("span");
      t.textContent = m.text;
      if (m.source === "ocr") {
        t.title = "Found by OCR";
        t.dataset.ocr = "";
      }
      const pg = document.createElement("button");
      pg.type = "button";
      pg.className = "link";
      pg.textContent = `p.${m.page + 1}`;
      pg.addEventListener("click", () => scrollToPage(m.page));
      lab.append(cb, t);
      li.append(lab, pg);
      ul.append(li);
    }
    det.append(ul);
    host.append(det);
  }
}

function groupBy(arr) {
  const m = new Map();
  for (const x of arr) m.set(x.label, [...(m.get(x.label) ?? []), x]);
  return m;
}

function scrollToPage(i) {
  if (state.view !== "source") showView("source");
  document.querySelector(`.page[data-index="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------- text view

function populateTextView() {
  const sel = $("textpage");
  sel.replaceChildren(
    ...state.pages.map((_, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = String(i + 1);
      return o;
    }),
  );
  $("textout").textContent = "";
  if ($("textview").open) showPageText();
}

async function showPageText() {
  const out = $("textout");
  if (!state.pages.length) {
    out.textContent = "Open a PDF first.";
    return;
  }
  const index = Number($("textpage").value || 0);
  try {
    const { text } = await engine.call("text", { index });
    const ocr = state.ocr[index]?.text;
    let shown = text.trim() ? text : "(No text on this page. It may be a scanned image: run OCR, or draw boxes.)";
    if (ocr) shown += `\n\n── OCR ──\n${ocr.trim() || "(OCR found no text)"}`;
    out.textContent = shown;
  } catch (e) {
    out.textContent = e.message;
    log("text view failed", e);
  }
}

// ---------------------------------------------------------------- redact

function invalidateOutput() {
  if (state.outPages.length || state.downloadUrl) clearOutput();
}

async function apply() {
  const btn = $("apply");
  const matches = state.matches.filter((m) => m.enabled).map(({ page, quads, source }) => ({ page, quads, source }));
  const boxes = state.boxes.map(({ page, rect }) => ({ page, rect }));
  const excluded = state.matches.filter((m) => !m.enabled).map(({ page, quads }) => ({ page, quads }));
  busy(btn, true, "Redacting…");
  $("find").disabled = true;
  try {
    const { bytes, report, pages } = await engine.call("redact", { ...searchPayload(), matches, boxes, excluded });
    clearOutput();
    state.outPages = pages;
    state.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = $("download");
    a.href = state.downloadUrl;
    a.download = `${state.fileName || "document"}-redacted.pdf`;
    if (!matches.length && !boxes.length) {
      report.warnings.unshift("Nothing was marked, so only the document clean-up options were applied.");
    }
    renderReport(report);
    $("tab-output").disabled = false;
    showView("output");
  } catch (e) {
    renderReport({ ok: false, failures: [e.message], warnings: [] });
    log("redact failed", e);
  } finally {
    busy(btn, false);
    $("find").disabled = !state.pages.length;
  }
}

function renderReport(report) {
  const host = $("report");
  host.replaceChildren();
  const head = document.createElement("p");
  head.className = "status";
  head.dataset.kind = report.ok ? "ok" : "error";
  head.textContent = report.ok
    ? "Checked: the output was reopened and none of the marked content could be found in it."
    : "The check found problems. Review them before using this file.";
  host.append(head);
  const list = (items, kind) => {
    if (!items.length) return;
    const ul = document.createElement("ul");
    ul.className = kind;
    for (const s of items) {
      const li = document.createElement("li");
      li.textContent = s;
      ul.append(li);
    }
    host.append(ul);
  };
  list(report.failures, "failures");
  list(report.warnings, "warnings");

  const dl = $("download");
  if (!state.downloadUrl) return;
  if (report.ok) {
    dl.hidden = false;
    $("override-row").hidden = true;
  } else {
    dl.hidden = true;
    $("override-row").hidden = false;
  }
}

// ---------------------------------------------------------------- OCR

const textlessPages = () => state.pages.map((p, i) => (p.chars === 0 ? i : -1)).filter((i) => i >= 0);

function renderOcrInfo() {
  $("ocr-row").hidden = !state.pages.length;
  const none = textlessPages().length;
  $("ocr-info").textContent = none
    ? `${none} of ${state.pages.length} page${state.pages.length === 1 ? " has" : "s have"} no text, which usually means a scan. OCR can read them so search works. It downloads about 7 MB the first time and takes a few seconds per page.`
    : "Every page has text. OCR is only needed if text appears inside images, such as a pasted screenshot.";
}

async function runOcr() {
  const btn = $("ocr-run");
  const status = $("ocr-status");
  const targets = $("ocr-all").checked ? state.pages.map((_, i) => i) : textlessPages();
  if (!targets.length) {
    setStatus(status, "No pages without text. Tick the box to OCR every page.");
    return;
  }
  busy(btn, true, "Reading…");
  $("find").disabled = true;
  $("apply").disabled = true;
  let low = 0;
  try {
    for (const [n, index] of targets.entries()) {
      const onProgress = (m) => {
        const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : "";
        setStatus(status, `Page ${index + 1} (${n + 1} of ${targets.length}): ${m.status}${pct}`);
      };
      setStatus(status, `Page ${index + 1} (${n + 1} of ${targets.length})…`);
      state.ocr[index] = await ocrPage(engine, index, { onProgress });
      low += state.ocr[index].lowConfidence;
    }
    const found = targets.filter((i) => state.ocr[i].text.trim()).length;
    setStatus(
      status,
      `OCR read ${found} of ${targets.length} page${targets.length === 1 ? "" : "s"}.` +
        (low ? ` ${low} word${low === 1 ? " was" : "s were"} hard to read; check those pages by eye.` : "") +
        " Now run Find matches.",
      "ok",
    );
    invalidateOutput();
    if ($("textview").open) showPageText();
  } catch (e) {
    setStatus(status, `OCR failed: ${e.message}`, "error");
    log("ocr failed", e);
  } finally {
    busy(btn, false);
    $("find").disabled = !state.pages.length;
    $("apply").disabled = !state.pages.length;
  }
}

// ---------------------------------------------------------------- batch

let batchEngine = null;

function clearBatch() {
  for (const u of state.batchUrls) URL.revokeObjectURL(u);
  state.batchUrls = [];
  $("batch-report").replaceChildren();
  $("batch-zip").hidden = true;
}

/** Make zip entry names unique and safe. */
function uniqueName(name, used) {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  let candidate = clean;
  for (let n = 2; used.has(candidate); n++) candidate = clean.replace(/(\.pdf)?$/i, ` (${n})$1`);
  used.add(candidate);
  return candidate;
}

async function runBatch() {
  const btn = $("batch-run");
  const payload = searchPayload();
  const report = $("batch-report");
  if (!payload.terms.length && !payload.regexes.length && !payload.presets.length) {
    report.textContent = "Enter something to search for first.";
    return;
  }
  clearBatch();
  busy(btn, true, "Working…");
  batchEngine ??= new Engine();
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>File</th><th>Matches</th><th>Result</th></tr></thead>";
  const tbody = document.createElement("tbody");
  table.append(tbody);
  report.replaceChildren(table);
  const passing = [];
  const used = new Set();

  for (const [i, file] of state.files.entries()) {
    const tr = document.createElement("tr");
    const [tdName, tdCount, tdResult] = ["td", "td", "td"].map((t) => document.createElement(t));
    tdName.className = "name";
    tdName.textContent = file.name;
    tdName.title = file.name;
    tdResult.textContent = "Working…";
    tr.append(tdName, tdCount, tdResult);
    tbody.append(tr);
    try {
      const isCurrent = i === state.current;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pages } = await batchEngine.call("open", {
        bytes,
        password: isCurrent ? state.password : "",
        options: readOptions(),
      });

      // The file under review keeps its reviewed matches, boxes and OCR.
      let extraText = isCurrent ? state.ocr : {};
      if (!isCurrent && $("batch-ocr").checked) {
        for (const [p, info] of pages.entries()) {
          if (info.chars !== 0) continue;
          tdResult.textContent = `OCR page ${p + 1}…`;
          extraText[p] = await ocrPage(batchEngine, p);
        }
      }
      let matches;
      let excluded = [];
      let boxes = [];
      if (isCurrent && state.matches.length) {
        matches = state.matches.filter((m) => m.enabled);
        excluded = state.matches.filter((m) => !m.enabled).map(({ page, quads }) => ({ page, quads }));
      } else {
        ({ matches } = await batchEngine.call("find", { ...payload, extraText }, { timeout: FIND_TIMEOUT_MS }));
      }
      if (isCurrent) boxes = state.boxes.map(({ page, rect }) => ({ page, rect }));
      const pick = ({ page, quads, source }) => ({ page, quads, source });
      const res = await batchEngine.call("redact", { ...payload, matches: matches.map(pick), boxes, excluded });

      tdCount.textContent = String(matches.length + boxes.length);
      const outName = uniqueName(file.name.replace(/\.pdf$/i, "") + "-redacted.pdf", used);
      const url = URL.createObjectURL(new Blob([res.bytes], { type: "application/pdf" }));
      state.batchUrls.push(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      if (res.report.ok) {
        passing.push([outName, res.bytes]);
        a.textContent = "Passed · download";
        tdResult.dataset.kind = matches.length || boxes.length ? "ok" : "warn";
        if (!matches.length && !boxes.length) a.textContent = "No matches · download";
      } else {
        a.textContent = `${res.report.failures.length} problem${res.report.failures.length === 1 ? "" : "s"} · download anyway`;
        tdResult.dataset.kind = "error";
        tdResult.title = res.report.failures.join("\n");
      }
      tdResult.replaceChildren(a);
    } catch (e) {
      tdResult.dataset.kind = "error";
      tdResult.textContent =
        e.code === "NEEDS_PASSWORD" ? "Password protected: open it on its own to unlock it" : e.message;
      log("batch file failed", file.name, e);
    }
  }

  if (passing.length) {
    // PDFs are already compressed; store rather than deflate again.
    const zipped = zipSync(Object.fromEntries(passing.map(([n, b]) => [n, [b, { level: 0 }]])));
    const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
    state.batchUrls.push(url);
    const z = $("batch-zip");
    z.href = url;
    z.download = "redacted.zip";
    z.textContent = `Download ${passing.length} passing file${passing.length === 1 ? "" : "s"} (.zip)`;
    z.hidden = false;
  }
  busy(btn, false);
}

// ---------------------------------------------------------------- draw mode

function setDrawing(on) {
  $("pages").classList.toggle("drawing", on);
  $("draw-toggle").setAttribute("aria-pressed", String(on));
}

// ---------------------------------------------------------------- wiring

function init() {
  // Presets grouped by region, each group collapsible so the list stays short.
  const presetsHost = $("presets");
  for (const region of ["General", "UK", "US"]) {
    const entries = Object.entries(PRESETS).filter(([, p]) => p.region === region);
    if (!entries.length) continue;
    const group = document.createElement("details");
    group.className = "preset-group";
    group.open = region !== "US"; // UK users are the majority so far; US is one click away
    group.dataset.region = region;
    const sum = document.createElement("summary");
    sum.textContent = region;
    group.append(sum);
    for (const [key, p] of entries) {
      const lab = document.createElement("label");
      lab.className = "check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = key;
      cb.addEventListener("change", () => {
        const n = group.querySelectorAll("input:checked").length;
        sum.dataset.count = n ? String(n) : "";
      });
      lab.append(cb, ` ${p.label}`);
      group.append(lab);
    }
    presetsHost.append(group);
  }

  $("file").addEventListener("change", (e) => openFiles(e.target.files));
  const drop = $("drop");
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  }
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    openFiles(e.dataTransfer.files);
  });
  // Dropping a file anywhere else would navigate away and show it in the browser.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  const unlock = () => {
    state.password = $("password").value;
    loadIntoEngine();
  };
  $("pw-go").addEventListener("click", unlock);
  $("password").addEventListener("keydown", (e) => e.key === "Enter" && unlock());

  $("find").addEventListener("click", find);
  $("ocr-run").addEventListener("click", runOcr);
  $("batch-run").addEventListener("click", runBatch);
  // Mouse users draw by default; on touch screens swiping should scroll until asked.
  setDrawing(window.matchMedia?.("(pointer: fine)").matches ?? true);
  $("draw-toggle").addEventListener("click", () => setDrawing(!$("pages").classList.contains("drawing")));
  $("textview").addEventListener("toggle", () => $("textview").open && showPageText());
  $("textpage").addEventListener("change", showPageText);
  $("apply").addEventListener("click", apply);
  $("tab-source").addEventListener("click", () => showView("source"));
  $("tab-output").addEventListener("click", () => showView("output"));
  $("override").addEventListener("change", (e) => ($("download").hidden = !e.target.checked));

  for (const k of OPTION_IDS) {
    $(`opt-${k}`).addEventListener("change", async () => {
      invalidateOutput();
      if (PREP_OPTIONS.has(k) && state.bytes) {
        // These change what is in the document being searched, so start again.
        state.matches = [];
        state.ocr = {}; // the rendered page changes, so earlier OCR no longer applies
        setStatus($("ocr-status"), "");
        for (const url of state.renderCache.source.values()) URL.revokeObjectURL(url);
        state.renderCache.source.clear();
        renderMatches();
        await loadIntoEngine();
      }
    });
  }
  $("opt-case").addEventListener("change", invalidateOutput);

  engine.ready.catch((e) => setStatus($("file-status"), `Couldn't load the PDF engine: ${e.message}`, "error"));
  log("ready");
}

init();
