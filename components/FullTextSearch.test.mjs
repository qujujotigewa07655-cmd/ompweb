import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FullTextSearch } = await jiti.import("./FullTextSearch.tsx");
const { getSearchMessageTarget, clearSearchMessageTarget } = await jiti.import("../lib/full-text-search-navigation.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; clearSearchMessageTarget("active"); setLocale("en"); });
const session = { id: "active", path: "/managed/session.jsonl", cwd: "/managed", created: "", modified: "", messageCount: 4, firstMessage: "unrelated" };
const result = { kind: "message", source: "message:workspace/session.jsonl", title: "Example", location: "Message 4 · toolResult · exact-entry", snippet: "a needle in output", matchStart: 2, matchEnd: 8, section: 3, offset: 90000, entryId: "exact-entry", session };

function submit(query = "needle") {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
}

test("active result carries the exact entry across session navigation, not just the session id", async () => {
  const selections = [];
  let closes = 0;
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { query: "needle", cursor: 0 });
    return new Response(JSON.stringify({ results: [result], nextCursor: null, warningCount: 0, warnings: [] }));
  };
  render(React.createElement(FullTextSearch, { onClose: () => closes++, onSelectSession: (value) => selections.push(value) }));
  submit();
  fireEvent.click(await screen.findByRole("button", { name: /Open exact match 1/ }));
  assert.deepEqual(selections, [session]);
  assert.equal(closes, 1);
  assert.equal(getSearchMessageTarget("other"), null);
  assert.equal(getSearchMessageTarget("active").result.entryId, "exact-entry");
  assert.equal(getSearchMessageTarget("active").result.offset, 90000);
  assert.equal(getSearchMessageTarget("active").query, "needle");
  assert.ok(getSearchMessageTarget("active"), "target survives the session-key remount");
});

test("archives open complete paginated read-only previews without selecting or restoring a session", async () => {
  let selected = 0;
  const previewRequests = [];
  globalThis.fetch = async (url) => {
    if (url === "/api/search") return new Response(JSON.stringify({ results: [{ ...result, kind: "archive", source: "archive:old.jsonl.gz" }], nextCursor: null, warningCount: 0, warnings: [] }));
    assert.ok(String(url).startsWith("/api/search/preview?"), "no restore endpoint is called");
    const params = new URL(String(url), "http://localhost").searchParams;
    previewRequests.push(params);
    const offset = Number(params.get("offset"));
    return new Response(JSON.stringify({ text: offset === 122668 ? "tail needle original" : "needle original tool output", location: result.location, offset, nextOffset: offset === 122668 ? null : 122668, previousOffset: 0 }));
  };
  render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => selected++ }));
  submit();
  fireEvent.click(await screen.findByRole("button", { name: /Open exact match 1/ }));
  assert.match((await screen.findByLabelText("Original matching content")).textContent, /original tool output/);
  assert.match(screen.getByText(/Archived message · read only/).textContent, /not restored/);
  assert.equal(previewRequests[0].get("entryId"), "exact-entry");
  assert.equal(previewRequests[0].get("section"), "3");
  assert.equal(previewRequests[0].get("offset"), "89900");
  fireEvent.click(screen.getByRole("button", { name: "More content" }));
  await waitFor(() => assert.match(screen.getByLabelText("Original matching content").textContent, /tail needle original/));
  assert.equal(screen.getByRole("button", { name: "More content" }).disabled, true);
  assert.equal(selected, 0);
});

test("document selection previews its exact page and forwards location to the file opener", async () => {
  const openings = [];
  const file = { ...result, kind: "file", source: "file:/managed/report.pdf", filePath: "/managed/report.pdf", location: "Page 7", section: 6, offset: 30, session: undefined, entryId: undefined };
  globalThis.fetch = async (url) => new Response(JSON.stringify(url === "/api/search"
    ? { results: [file], nextCursor: 50, warningCount: 1, warnings: ["broken.docx: invalid document"] }
    : { text: "needle on page seven", location: "Page 7", offset: 0, nextOffset: null, previousOffset: null }));
  render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => assert.fail("file should not select session"), onOpenFile: (...args) => openings.push(args) }));
  submit();
  fireEvent.click(await screen.findByRole("button", { name: /Open exact match 1/ }));
  await screen.findByLabelText("Original matching content");
  fireEvent.click(screen.getByRole("button", { name: "Open file", exact: true }));
  assert.deepEqual(openings, [["/managed/report.pdf", "Page 7", "needle"]]);
  assert.match(screen.getByRole("alert").textContent, /Results are incomplete/);
  assert.equal(screen.getByRole("button", { name: "More matches" }).disabled, false);
});

test("cancellation aborts the request and displays an explicit incomplete status", async () => {
  let signal;
  globalThis.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
  render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => {} }));
  submit();
  fireEvent.click(screen.getByRole("button", { name: "Cancel search" }));
  assert.equal(signal.aborted, true);
  assert.match(screen.getByRole("status").textContent, /cancelled.*No complete result page/);
});

test("server search failures stay visible instead of appearing as no matches", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Managed source unreadable" }), { status: 400 });
  render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => {} }));
  submit();
  assert.match((await screen.findByRole("alert")).textContent, /Managed source unreadable/);
  assert.match(screen.getByRole("status").textContent, /results are incomplete/);
});

test("Unicode matches keep their original query and highlight the actual folded text", async () => {
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { query: "οσ", cursor: 0 });
    return new Response(JSON.stringify({ results: [{ ...result, snippet: "before ΟΣ after", matchStart: 7, matchEnd: 9 }], nextCursor: null, warningCount: 0, warnings: [] }));
  };
  render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => {} }));
  submit("οσ");
  const match = await screen.findByRole("button", { name: /Open exact match 1/ });
  assert.equal(match.querySelector("mark")?.textContent, "ΟΣ");
  fireEvent.click(match);
  assert.equal(getSearchMessageTarget("active").query, "οσ");
});

test("index progress follows building, refreshing and idle phases without overwriting completed results", async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let poll;
  let finishSearch;
  let finishStatus;
  let status = { phase: "building", done: 7 };
  try {
    globalThis.setInterval = (callback) => { poll = callback; return 1; };
    globalThis.clearInterval = () => {};
    globalThis.fetch = (url) => {
      if (url === "/api/search") return new Promise((resolve) => { finishSearch = resolve; });
      assert.equal(url, "/api/search/status");
      return Promise.resolve({ json: () => new Promise((resolve) => { finishStatus = () => resolve(status); }) });
    };
    render(React.createElement(FullTextSearch, { onClose: () => {}, onSelectSession: () => {} }));
    submit();
    const searching = screen.getByRole("status").textContent;
    for (const next of [{ phase: "building", done: 7 }, { phase: "refreshing", done: 12 }, { phase: "idle", done: 12 }]) {
      status = next;
      await act(async () => { poll(); });
      await act(async () => { finishStatus(); });
      const message = screen.getByRole("status").textContent;
      if (status.phase === "building") assert.match(message, new RegExp(`${status.done} files processed`));
      else assert.equal(message, searching);
    }
    await act(async () => { poll(); });
    await act(async () => { finishSearch(new Response(JSON.stringify({ results: [result], nextCursor: null, warningCount: 0, warnings: [] }))); });
    const completed = screen.getByRole("status").textContent;
    assert.match(completed, /Matches 1–1/);
    status = { phase: "building", done: 99 };
    await act(async () => { finishStatus(); });
    assert.equal(screen.getByRole("status").textContent, completed, "a late poll cannot replace the final search status");
  } finally {
    cleanup();
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test("the visible close label follows the selected language", () => {
  setLocale("ja");
  let closed = false;
  render(React.createElement(FullTextSearch, { onClose: () => { closed = true; }, onSelectSession: () => {} }));
  const close = screen.getByRole("button", { name: "全文検索を閉じる" });
  assert.equal(close.textContent, "全文検索を閉じる");
  fireEvent.click(close);
  assert.equal(closed, true);
});
