import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { JSDOM } from "jsdom";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, filterModelOptions } = await jiti.import("./ChatInput.tsx");
const { setDraft, getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
const { translate } = await jiti.import("@/lib/i18n");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  clearDraft("chat-input-model-recovery");
  localStorage.clear();
  delete window.matchMedia;
  delete window.HTMLElement.prototype.scrollIntoView;
});

test("provider-defined reasoning levels appear once in the trigger", () => {
  for (const thinkingLevel of ["ultra", "ultrathink-extended", "constructor"]) {
    const html = renderToStaticMarkup(React.createElement(ChatInput, {
      onSend() {},
      onThinkingLevelChange() {},
      thinkingLevel,
      isStreaming: false,
    }));
    const dom = new JSDOM(html);
    try {
      const trigger = dom.window.document.querySelector(".composer-thinking-control > button");
      assert.equal(trigger.textContent, thinkingLevel);
      assert.ok(trigger.getAttribute("aria-label").endsWith(`: ${thinkingLevel}`));
    } finally {
      dom.window.close();
    }
  }
});

test("shows Queue instead of Stop for typed text during a run", () => {
  const draftKey = "chat-input-queue-action-test";
  setDraft(draftKey, { value: "Continue after the current run", images: [], files: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onFollowUp() {},
        isStreaming: true,
        draftKey,
      }),
    );

    assert.match(html, />(Queue|chatInput\.queue)</);
    assert.match(html, /title="(Queue this message after the agent finishes|chatInput\.queueMessage)"/);
    assert.doesNotMatch(html, />(Stop|chatInput\.stop)</);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("formats structured Claude low-priority state in the browser locale", () => {
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3_600;
  const time = new Date(resetsAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      isStreaming: false,
      usageLimit: { stage: "low_priority", resetsAtSec, allowanceLeftPercent: 62 },
    }),
  );
  assert.match(html, new RegExp(`low priority until ${time.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} · 62% left`));
});

test("formats every Claude usage-limit stage", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const shortReset = nowSec + 3_600;
  const longReset = nowSec + 86_400;
  const shortTime = new Date(shortReset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const longTime = new Date(longReset * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const rows = [
    [{ stage: "low_priority", resetsAtSec: shortReset }, `low priority until ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: false }, "limit reached · wrapping up"],
    [{ stage: "wrap_up", resetsAtSec: shortReset, extraUsage: false }, `limit reached · wrapping up · resets ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: true }, "limit reached · wrap-up, then extra usage"],
    [{ stage: "low_priority", resetsAtSec: longReset }, `low priority until ${longTime}`],
  ];
  for (const [usageLimit, label] of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, isStreaming: false, usageLimit }),
    );
    assert.ok(html.includes(label), `${JSON.stringify(usageLimit)} should render ${label}`);
  }
});

test("never renders a null percentage, an invalid date, or a past reset clock", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const pastSec = nowSec - 3_600;
  const rows = [
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: null },
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: Number.NaN },
    { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: undefined, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: null },
    { stage: "low_priority", resetsAtSec: pastSec, allowanceLeftPercent: 62 },
    { stage: "wrap_up", resetsAtSec: null, extraUsage: false },
    { stage: "wrap_up", resetsAtSec: pastSec, extraUsage: false },
  ];
  for (const usageLimit of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, isStreaming: false, usageLimit }),
    );
    const label = `${JSON.stringify(usageLimit)} -> ${html}`;
    // "null" / "NaN" / "Invalid Date" reaching the label is the bug this pins:
    // every one of them is a value the user would plan their session around.
    assert.ok(!html.includes("Invalid Date"), `invalid date rendered: ${label}`);
    assert.ok(!html.includes("null%"), `null percentage rendered: ${label}`);
    assert.ok(!html.includes("NaN%"), `NaN percentage rendered: ${label}`);
    // A reset already in the past must not render a plausible wrong clock.
    if (usageLimit.resetsAtSec === pastSec) {
      assert.ok(!html.includes(new Date(pastSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        `past reset clock rendered: ${label}`);
    }
  }
  // The allowance is still worth showing when the reset time is unusable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
      }),
    ),
    /low priority · 62% left/,
  );
  // ...and something is still shown when neither is usable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null },
      }),
    ),
    /class="composer-usage-limit-badge"[^>]*>low priority</,
  );
});

test("shows the Slow toggle only when omp reports /slow applies, pressed when enabled", () => {
  const render = (props) => renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, isStreaming: false, onSlowModeChange() {}, ...props }),
  );
  // Older omp omits the field; an unsupported model reports false.
  for (const props of [{}, { slowModeSupported: false, slowModeEnabled: true }]) {
    assert.doesNotMatch(render(props), /composer-slow-control/);
  }
  assert.match(
    render({ slowModeSupported: true, slowModeEnabled: true }),
    /<button[^>]*class="composer-slow-control"[^>]*aria-pressed="true"/,
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
  assert.match(html, /title="(No available models|chatInput\.noAvailableModels)"/);
});


test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { objective: "Ship the active goal bar", startedAt: 0 },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
      onAdvisorChange() {},
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  // The advisor toggle moved into the plus menu: no pressed toggle inline,
  // but the plus trigger renders for the same props.
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("shows the advisor thunder indicator with the reviewing model and reasoning", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      advisorActive: true,
      advisorModel: { name: "GPT-5.6 Luna", reasoning: "xhigh" },
    }),
  );

  assert.match(html, /aria-label="[^"]*GPT-5\.6 Luna[^"]*xhigh[^"]*"/);
});

test("filters model options by display name, identifier, and provider", () => {
  const options = [
    { provider: "OpenAI", modelId: "gpt-5.2", name: "GPT-5.2" },
    { provider: "Anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];

  assert.deepEqual(filterModelOptions(options, "sonnet", "en"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "5.2", "en"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "OPENAI", "en"), [options[0]]);
  assert.equal(filterModelOptions(options, "   ", "en"), options);
});

test("renders single queued prompt in compact bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First follow-up task"],
        steering: [],
      },
    }),
  );

  assert.match(html, /First follow-up task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.match(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("keeps editing and deletion but hides Steer for a single queued steer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onPromoteQueuedToSteer() {},
      isStreaming: true,
      queuedMessages: {
        followUp: [],
        steering: ["Already prioritized task"],
      },
    }),
  );

  assert.match(html, /Already prioritized task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.doesNotMatch(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("renders multiple queued prompts with count and expand action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First task", "Second task"],
        steering: ["Priority steer"],
      },
    }),
  );

  assert.match(html, /\(3\)/);
  assert.match(html, />(Show all queued prompts|Show all|chatInput\.expandQueued)</);
  assert.match(html, /First task/);
});


test("nested model picker groups by provider and pins the current provider first", async () => {
  const { groupModelOptionsByProvider, orderProviderGroups } = await jiti.import("./ChatInput-model-picker.tsx");
  const options = [
    { provider: "anthropic", modelId: "claude", name: "Claude" },
    { provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { provider: "openai", modelId: "gpt-5.5", name: "GPT-5.5" },
    { provider: "pi", modelId: "pi-1", name: "Pi" },
  ];
  const grouped = groupModelOptionsByProvider(options);
  assert.deepEqual(grouped.map((g) => g.provider), ["anthropic", "openai", "pi"]);
  assert.equal(grouped[1].options.length, 2);

  const ordered = orderProviderGroups(grouped, "openai");
  assert.deepEqual(ordered.map((g) => g.provider), ["openai", "anthropic", "pi"]);
});

test("model picker panel renders providers rail, models pane, and Add Providers", async () => {
  const { ModelPickerPanel } = await jiti.import("./ChatInput-model-picker.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ModelPickerPanel, {
      modelOptions: [
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "codex", modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        { provider: "pi", modelId: "pi-1", name: "Pi One" },
      ],
      filteredModelOptions: [
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "codex", modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        { provider: "pi", modelId: "pi-1", name: "Pi One" },
      ],
      currentModel: { provider: "codex", modelId: "gpt-5.6-sol" },
      modelSearchQuery: "",
      onSearchQueryChange() {},
      isMobile: false,
      onSelectModel() {},
      onOpenProviders() {},
    }),
  );

  assert.match(html, /picker-nested-providers/);
  assert.match(html, /picker-nested-models/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.match(html, /GPT-5\.6 Terra/);
  assert.match(html, />codex</);
  assert.match(html, />pi</);
  assert.match(html, />(Add Providers|chatInput\.addProviders)</);
});


test("exposes tool presets through the plus menu when a handler is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      toolPreset: "full",
      onToolPresetChange() {},
    }),
  );

  // No inline preset trigger remains; the plus trigger carries the menu.
  assert.doesNotMatch(html, /aria-label="Change tool preset: full"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
  assert.match(html, /aria-haspopup="menu"/);
});

test("plus trigger renders without change handlers", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
    }),
  );

  assert.doesNotMatch(html, /Change tool preset/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("renders live status bar attached to the composer top edge when statusText is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});

test("omits live status bar when statusText is absent or null", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      statusText: null,
    }),
  );

  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(html, /Waiting for model/);
});

test("renders both queued prompts and attached status bar together", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
      queuedMessages: {
        steer: [],
        followUp: ["Next prompt to run"],
      },
    }),
  );

  assert.match(html, /Next prompt to run/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});

test("imperative model picker opens existing options without changing the draft or sending", async () => {
  const draft = {
    value: "Keep this unsent draft",
    images: [],
    files: [{ name: "notes.txt", mimeType: "text/plain", content: "Keep this attachment", size: 20 }],
  };
  setDraft("chat-input-model-recovery", draft);
  const ref = React.createRef();
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  render(React.createElement(ChatInput, {
    ref,
    draftKey: "chat-input-model-recovery",
    isStreaming: false,
    onSend: record("send"),
    onSteer: record("steer"),
    onFollowUp: record("followUp"),
    onAbort: record("abort"),
    onModelChange: record("model"),
    model: { provider: "test", modelId: "current" },
    modelList: [
      { provider: "test", id: "current", name: "Current model" },
      { provider: "test", id: "other", name: "Other model" },
    ],
  }));
  const textarea = screen.getByRole("textbox");
  const hydratedDraft = getDraft("chat-input-model-recovery");
  assert.equal(screen.queryByRole("dialog"), null);
  act(() => ref.current.openModelPicker());
  assert.ok(screen.getByRole("menuitemradio", { name: /Other model/ }));
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("searchbox", { name: translate("chatInput.searchModels") }), "model search receives focus"));
  assert.equal(textarea.value, draft.value);
  assert.ok(screen.getByText("notes.txt"));
  assert.deepEqual(getDraft("chat-input-model-recovery"), hydratedDraft);
  assert.deepEqual(calls, []);
});

test("imperative model picker follows native busy, loading, and availability guards", () => {
  const ref = React.createRef();
  const base = { ref, onSend() {}, onModelChange() {}, isStreaming: false };
  const { rerender } = render(React.createElement(ChatInput, {
    ...base,
    isStreaming: true,
    modelList: [{ provider: "test", id: "other", name: "Other model" }],
  }));
  act(() => ref.current.openModelPicker());
  assert.equal(screen.queryByRole("dialog"), null);
  for (const props of [
    { modelsLoading: true, modelList: [] },
    { modelList: [] },
    { modelList: [{ provider: "test", id: "other", name: "Other model" }], onModelChange: undefined },
  ]) {
    rerender(React.createElement(ChatInput, { ...base, ...props }));
    act(() => ref.current.openModelPicker());
    assert.equal(screen.queryByRole("dialog"), null);
  }
  rerender(React.createElement(ChatInput, {
    ...base,
    modelList: [{ provider: "test", id: "other", name: "Other model" }],
  }));
  act(() => ref.current.openModelPicker());
  assert.ok(screen.getByRole("menuitemradio", { name: /Other model/ }));
});

// The first send of a new chat creates the session. ChatWindow then remounts the
// composer with the session id, so the composer the user typed in is replaced
// while `onSend` is still pending. That predecessor leaves its key with the sent
// text still in state; saving it back made the next new chat of the same project
// open with a prompt that had already been sent.
test("a first send does not leave its prompt on the new-chat draft key", async () => {
  const newChatKey = "new:/workspace-draft-send";
  const sessionKey = "draft-send-created-session";
  clearDraft(newChatKey);
  clearDraft(sessionKey);
  const accepted = Promise.withResolvers();
  const view = render(React.createElement(ChatInput, {
    draftKey: newChatKey,
    isStreaming: false,
    onSend: () => accepted.promise,
  }));
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Sent once" } });
    assert.equal(getDraft(newChatKey)?.value, "Sent once", "typing persists the draft under the new-chat key");
    fireEvent.click(screen.getByRole("button", { name: translate("chatInput.send") }));
    // The session shows up while the send is still in flight: a fresh composer
    // mounts with the session id, and the old one unmounts.
    view.rerender(React.createElement(ChatInput, { draftKey: sessionKey, isStreaming: false, onSend: () => Promise.resolve(true) }));
    view.unmount();
    await act(async () => { accepted.resolve(true); });
    assert.equal(getDraft(newChatKey), null, "the sent prompt must not stay on the new-chat draft key");
    const next = render(React.createElement(ChatInput, { draftKey: newChatKey, isStreaming: false, onSend() {} }));
    try {
      assert.equal(screen.getByRole("textbox").value, "", "the next new chat of that project opens empty");
    } finally { next.unmount(); }
  } finally {
    clearDraft(newChatKey);
    clearDraft(sessionKey);
  }
});
