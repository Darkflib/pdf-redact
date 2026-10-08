// SPDX-License-Identifier: AGPL-3.0-or-later
//
// worker.js — runs MuPDF off the main thread. The UI talks to it with
// {id, type, payload} messages and gets {id, ok, result|error} back.
// All document bytes stay in this worker's memory; nothing is sent anywhere.

import * as mupdf from "./vendor/mupdf/mupdf.js";
import * as core from "./core.js";

const state = {
  bytes: null, // original file, never modified
  password: "",
  options: { ...core.DEFAULT_OPTIONS },
  source: null, // prepared PDFDocument for preview/search
  output: null, // redacted PDFDocument for result preview
};

function dropDoc(key) {
  try {
    state[key]?.destroy?.();
  } catch (e) {
    console.warn(`[worker] failed to free ${key}:`, e);
  }
  state[key] = null;
}

function pageInfo(pdf) {
  const pages = [];
  for (let i = 0; i < pdf.countPages(); i++) pages.push({ bounds: pdf.loadPage(i).getBounds() });
  return pages;
}

function compile(payload) {
  return core.compilePatterns(
    { terms: payload.terms ?? [], regexes: payload.regexes ?? [], presets: payload.presets ?? [] },
    state.options,
  );
}

const handlers = {
  /** Load a file (or reload with new options/password). */
  open({ bytes, password = "", options = {} }) {
    if (bytes) state.bytes = new Uint8Array(bytes);
    if (!state.bytes) throw new core.RedactionError("No file loaded", "NO_FILE");
    state.password = password;
    state.options = { ...core.DEFAULT_OPTIONS, ...options };
    dropDoc("source");
    dropDoc("output");
    state.source = core.openPrepared(mupdf, state.bytes, { password, options: state.options });
    return { pages: pageInfo(state.source) };
  },

  render({ which = "source", index, zoom = 2 }) {
    const pdf = state[which];
    if (!pdf) throw new core.RedactionError(`No ${which} document`, "NO_FILE");
    const r = core.renderPage(mupdf, pdf, index, zoom);
    return { result: r, transfer: [r.png.buffer] };
  },

  /** The exact text search runs against, for diagnosing misses. */
  text({ index }) {
    if (!state.source) throw new core.RedactionError("No file loaded", "NO_FILE");
    return { text: core.pageText(state.source.loadPage(index)).text };
  },

  find(payload) {
    if (!state.source) throw new core.RedactionError("No file loaded", "NO_FILE");
    return { matches: core.findMatches(state.source, compile(payload)) };
  },

  redact(payload) {
    if (!state.bytes) throw new core.RedactionError("No file loaded", "NO_FILE");
    const { bytes, report } = core.redact(mupdf, state.bytes, {
      matches: payload.matches ?? [],
      boxes: payload.boxes ?? [],
      excluded: payload.excluded ?? [],
      patterns: compile(payload),
      password: state.password,
      options: state.options,
    });
    dropDoc("output");
    state.output = mupdf.Document.openDocument(bytes.slice(), "application/pdf").asPDF();
    // Send a copy; keep nothing else around that could be confused with the original.
    return { result: { bytes, report, pages: pageInfo(state.output) }, transfer: [bytes.buffer] };
  },

  close() {
    dropDoc("source");
    dropDoc("output");
    state.bytes = null;
    state.password = "";
    return {};
  },
};

self.onmessage = ({ data }) => {
  const { id, type, payload } = data ?? {};
  const handler = handlers[type];
  if (!handler) {
    self.postMessage({ id, ok: false, error: { message: `Unknown request ${type}`, code: "BAD_REQUEST" } });
    return;
  }
  try {
    const out = handler(payload ?? {});
    // Handlers either return a plain result or {result, transfer}.
    const result = "transfer" in out ? out.result : out;
    self.postMessage({ id, ok: true, result }, out.transfer ?? []);
  } catch (e) {
    console.error(`[worker] ${type} failed:`, e);
    self.postMessage({
      id,
      ok: false,
      error: { message: e?.message ?? String(e), code: e?.code ?? "INTERNAL" },
    });
  }
};

self.postMessage({ type: "ready" });
