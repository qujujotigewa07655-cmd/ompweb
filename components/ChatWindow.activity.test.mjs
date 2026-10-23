import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatWindow, renderActivityPieces } = await jiti.import("./ChatWindow.tsx");
const { selectSessionHistory } = await jiti.import("@/lib/session-sync");
const { setDraft, getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
const { navigateToSearchMessage, clearSearchMessageTarget } = await jiti.import("@/lib/full-text-search-navigation");
const { translate } = await jiti.import("@/lib/i18n");

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });

test("folded activity keeps tool calls from separate messages as separate entries", () => {
  const thinking = { type: "thinking", thinking: "plan" };
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([thinking, call("b"), call("c")]),
    { role: "custom", customType: "developer", content: "notice", display: true },
    assistant([call("d")]),
  ];
  const pieces = [
    { index: 1, blocks: messages[1].content },
    { index: 2, blocks: messages[2].content },
    { index: 3 },
    { index: 4, blocks: messages[4].content },
  ];
  const calls = [];
  renderActivityPieces(messages, pieces, (idx, options) => { calls.push({ idx, options }); return null; });

  // One entry per piece, in order: nothing merged across messages, and the
  // parallel calls of message 2 stay together with their thinking block.
  assert.deepEqual(calls.map(({ idx }) => idx), [1, 2, 3, 4]);
  assert.deepEqual(
    calls.map(({ options }) => options.messageOverride?.content.map((b) => b.toolCallId ?? b.type)),
    [["a"], ["thinking", "b", "c"], undefined, ["d"]],
  );
  assert.deepEqual(calls[1].options.sourceBlockIndices, [0, 1, 2]);
  assert.equal(new Set(calls.map(({ idx, options }) => `${options.keyPrefix}-${idx}`)).size, calls.length);
});

const CHOOSE_MODEL = translate("chatWindow.chooseModel");
const EXTERNAL_STATUS = translate("chatWindow.externalRunStatus");
const MODEL = { provider: "test", id: "current", name: "Current model" };
const USER = { role: "user", content: "A question" };
const FAILURE = { ...assistant([]), stopReason: "error", errorMessage: "Provider unavailable" };
let fixture;
let sequence = 0;
let restoreBrowser;

class TestObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  constructor() {
    queueMicrotask(() => {
      if (this.readyState === TestEventSource.CLOSED) return;
      this.readyState = TestEventSource.OPEN;
      this.onopen?.({});
    });
  }
  close() { this.readyState = TestEventSource.CLOSED; }
}

beforeEach(() => {
  const replace = [
    [globalThis, "ResizeObserver", TestObserver],
    [globalThis, "IntersectionObserver", TestObserver],
    [globalThis, "EventSource", TestEventSource],
    [globalThis, "KeyboardEvent", window.KeyboardEvent],
    [globalThis, "fetch", async (url, init = {}) => {
      const parsed = new URL(String(url), "https://omp.test");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      fixture.calls.push({ url: parsed, method: init.method ?? "GET", body });
      let value;
      if (parsed.pathname === "/api/models") {
        value = { models: { current: MODEL.name }, modelList: [MODEL], defaultModel: { provider: MODEL.provider, modelId: MODEL.id } };
      } else if (parsed.pathname.endsWith("/state")) {
        value = fixture.agent;
      } else if (parsed.pathname.endsWith("/subagents")) {
        value = { subagents: [] };
      } else if (parsed.pathname.endsWith("/context")) {
        const context = fixture.context;
        if (!parsed.searchParams.has("sync")) value = { context };
        else value = {
          ...selectSessionHistory(context, parsed.searchParams.has("cursor") ? JSON.parse(parsed.searchParams.get("cursor")) : null),
          sessionId: fixture.id,
          leafId: parsed.searchParams.get("leafId") ?? "live-leaf",
          live: null,
        };
      } else if (parsed.pathname === `/api/sessions/${fixture.id}`) {
        value = { sessionId: fixture.id, filePath: "/fixture/session.jsonl", tree: [], leafId: "live-leaf", context: fixture.context };
      } else if (parsed.pathname.startsWith("/api/agent/")) {
        value = init.method === "POST" ? { success: true, data: {} } : fixture.agent;
      } else if (parsed.pathname === "/api/github-repo") {
        value = { repo: null };
      } else if (parsed.pathname === "/api/search/preview") {
        value = { text: "Provider unavailable", offset: 0, previousOffset: null, nextOffset: null };
      } else {
        return Response.json({}, { status: 404 });
      }
      return Response.json(value);
    }],
    [window, "matchMedia", (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })],
    [window.HTMLElement.prototype, "scrollIntoView", () => {}],
    [window.HTMLElement.prototype, "scrollTo", () => {}],
  ];
  restoreBrowser = replace.map(([target, key, value]) => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    return () => {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    };
  });
});

afterEach(() => {
  cleanup();
  if (fixture) {
    clearDraft(fixture.id);
    clearSearchMessageTarget(fixture.id);
  }
  for (const restore of restoreBrowser) restore();
  localStorage.clear();
  sessionStorage.clear();
});

async function mountWindow(messages, { agent = { running: false, state: {} }, inputRef = React.createRef() } = {}) {
  fixture = {
    id: `window-recovery-${++sequence}`,
    calls: [],
    agent,
    context: {
      messages,
      entryIds: messages.map((_, index) => `entry-${index}`),
      todoPhases: [],
      thinkingLevel: "off",
      model: { provider: MODEL.provider, modelId: MODEL.id },
    },
  };
  const draft = {
    value: "My unsent question",
    images: [],
    files: [{ name: "notes.txt", mimeType: "text/plain", content: "Unsent attachment", size: 17 }],
  };
  setDraft(fixture.id, draft);
  let selectLeaf;
  const view = render(React.createElement(ChatWindow, {
    session: { id: fixture.id, cwd: "/workspace", name: "Test session", messageCount: messages.length },
    newSessionCwd: null,
    chatInputRef: inputRef,
    onBranchDataChange: (_tree, _leaf, onLeafChange) => { selectLeaf = onLeafChange; },
  }));
  await waitFor(() => assert.ok(view.queryByRole("log")));
  await waitFor(() => assert.ok(fixture.calls.some(({ url }) => url.pathname.endsWith("/context"))));
  await act(async () => {});
  return { ...view, draft, inputRef, selectLeaf: (leaf) => selectLeaf(leaf) };
}

test("latest failure offers keyboard model selection from a minimized composer without replaying or changing the draft", async () => {
  const view = await mountWindow([USER, FAILURE]);
  const textarea = screen.getByRole("textbox");
  const hydratedDraft = getDraft(fixture.id);
  fireEvent.click(screen.getByRole("button", { name: translate("chatWindow.minimizeComposer") }));
  assert.equal(screen.queryByRole("textbox"), null);
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("button", { name: translate("chatWindow.expandComposer") }), "minimization finishes moving focus"));
  const choose = screen.getByRole("button", { name: CHOOSE_MODEL });
  choose.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => assert.ok(screen.queryByRole("menuitemradio", { name: /Current model/ }), "keyboard activation opens model choices"));
  assert.equal(screen.getByRole("textbox", { name: textarea.getAttribute("aria-label") }), textarea, "the composer stayed mounted");
  assert.equal(textarea.value, view.draft.value);
  assert.deepEqual(getDraft(fixture.id), hydratedDraft);
  assert.deepEqual(fixture.calls.filter(({ method }) => method === "POST"), [], "opening the picker issues no agent command");
});

test("recovery uses only the latest failed assistant after the latest user and excludes cancellations", async () => {
  const cases = [
    [[USER, FAILURE], true],
    [[USER, { ...FAILURE, errorMessage: "  " }], true],
    [[USER, { ...FAILURE, stopReason: "stop", errorMessage: "Provider failed" }], true],
    [[USER, { ...FAILURE, stopReason: "stop", errorMessage: "  " }], false],
    [[USER, { ...FAILURE, errorMessage: "Interrupted by user" }], false],
    [[USER, { ...FAILURE, stopReason: "aborted" }], false],
    [[USER, FAILURE, { role: "user", content: "A newer question" }], false],
    [[USER, FAILURE, assistant([{ type: "text", text: "Recovered successfully" }])], false],
    [[FAILURE], false],
  ];
  for (const [messages, expected] of cases) {
    const view = await mountWindow(messages);
    assert.equal(!!view.queryByRole("button", { name: CHOOSE_MODEL }), expected, JSON.stringify(messages));
    view.unmount();
    clearDraft(fixture.id);
  }
});

test("recovery is absent without an input ref, during a local run, and during compaction", async () => {
  for (const options of [
    { inputRef: null },
    { agent: { running: true, state: { isStreaming: true } } },
    { agent: { running: true, state: { isBashRunning: true } } },
    { agent: { running: false, state: { isCompacting: true } } },
  ]) {
    const view = await mountWindow([USER, FAILURE], options);
    assert.equal(view.queryByRole("button", { name: CHOOSE_MODEL }), null);
    view.unmount();
    clearDraft(fixture.id);
  }
});

test("branch, precompaction, and search views hide recovery", async () => {
  for (const mode of ["branch", "precompaction", "search"]) {
    const messages = [{ role: "custom", customType: "compaction", content: "Compacted", display: true }, USER, FAILURE];
    const view = await mountWindow(messages);
    assert.ok(view.getByRole("button", { name: CHOOSE_MODEL }));
    if (mode === "branch") {
      await act(async () => { await view.selectLeaf("historical-leaf"); });
    } else if (mode === "precompaction") {
      fireEvent.click(view.getByRole("button", { name: translate("chatWindow.viewPreCompactionHistory") }));
      await waitFor(() => assert.ok(view.queryByRole("button", { name: translate("chatWindow.returnToCompactHistory") })));
    } else {
      act(() => navigateToSearchMessage({ session: { id: fixture.id }, source: "session", section: 0, offset: 0, kind: "session", title: "Failure", location: "Saved message" }, "Provider"));
    }
    assert.equal(view.queryByRole("button", { name: CHOOSE_MODEL }), null);
    view.unmount();
    clearSearchMessageTarget(fixture.id);
    clearDraft(fixture.id);
  }
});

test("external activity is explicitly inferred and hidden in historical and local-run views", async () => {
  const messages = [USER, assistant([call("pending")])];
  for (const mode of ["active", "branch", "precompaction", "search", "local", "compacting"]) {
    const context = [{ role: "custom", customType: "compaction", content: "Compacted", display: true }, ...messages];
    const agent = mode === "local"
      ? { running: true, state: { isStreaming: true } }
      : { running: false, state: { isCompacting: mode === "compacting" } };
    const view = await mountWindow(context, { agent });
    if (mode === "branch") {
      await act(async () => { await view.selectLeaf("historical-leaf"); });
    } else if (mode === "precompaction") {
      fireEvent.click(view.getByRole("button", { name: translate("chatWindow.viewPreCompactionHistory") }));
      await waitFor(() => assert.ok(view.queryByRole("button", { name: translate("chatWindow.returnToCompactHistory") })));
    } else if (mode === "search") {
      act(() => navigateToSearchMessage({ session: { id: fixture.id }, source: "session", section: 0, offset: 0, kind: "session", title: "Tool call", location: "Saved message" }, "pending"));
    }
    const status = view.queryAllByRole("status").find((node) => node.textContent === EXTERNAL_STATUS);
    assert.equal(!!status, mode === "active", mode);
    view.unmount();
    clearSearchMessageTarget(fixture.id);
    clearDraft(fixture.id);
  }
});

test("live tails keep duplicate metadata hidden without folding the active tool", async () => {
  const marker = {
    role: "custom",
    customType: "session-event:model",
    content: "Model → test/live-tail",
    display: true,
    details: { model: "test/live-tail" },
  };
  const messages = [USER, marker, { ...marker }, assistant([call("pending-tool")])];
  for (const running of [false, true]) {
    const view = await mountWindow(messages, { agent: { running, state: { isStreaming: running } } });
    assert.equal(view.getAllByText(translate("sessionEvent.model", { value: marker.details.model })).length, 1);
    const visibleToolButtons = view.getAllByRole("button").filter((button) => button.classList.contains("activity-row-trigger"));
    assert.equal(visibleToolButtons.length, 1, running ? "local live tool is visible" : "external live tool is visible");
    assert.equal(view.container.querySelector(".process-details-toggle"), null, "the active tool is not folded");
    assert.equal(visibleToolButtons[0].closest("[data-message-index]")?.getAttribute("data-message-index"), "3", "the tool keeps its original message index");
    view.unmount();
    clearDraft(fixture.id);
  }
});
