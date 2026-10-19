import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { markdownCodeRenderer } = await jiti.import("./MarkdownCode.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { OmpUiActionContext } = await jiti.import("../lib/omp-ui-actions.ts");

const label = "Запустить проверку";
const source = JSON.stringify({ type: "panel", title: "Проверка", items: [
  { type: "stat", label: "Готово", value: 3 },
  { type: "action", label, message: "!literal action" },
] });
const markdown = `\`\`\`omp-ui\n${source}\n\`\`\``;
const assistant = { role: "assistant", content: [{ type: "text", text: markdown }] };

afterEach(cleanup);

test("chat Markdown and the shared file-preview renderer show readonly cards by default", () => {
  const chat = render(React.createElement(MarkdownBody, null, markdown));
  assert.equal(chat.getByRole("button", { name: label }).disabled, true);
  assert.ok(chat.getByRole("heading", { name: "Проверка" }));
  cleanup();
  const file = render(React.createElement(markdownCodeRenderer({ defaultPreview: true }), { className: "language-omp-ui" }, `${source}\n`));
  assert.equal(file.getByRole("button", { name: label }).disabled, true);
  assert.ok(file.getByRole("heading", { name: "Проверка" }));
});

test("only the explicit owning assistant text can confirm an action", async () => {
  const sent = [];
  const scope = { sessionId: "owner", send: async (message) => { sent.push(message); return true; } };
  const view = render(React.createElement(MessageView, { message: assistant, sessionId: "owner", ompUiAction: scope }));
  assert.equal(view.getByRole("button", { name: label }).disabled, false);
  fireEvent.click(view.getByRole("button", { name: label }));
  assert.deepEqual(sent, []);
  assert.match(view.getByRole("dialog").textContent, /OMP UI — действие пользователя:\s*!literal action/);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Подтвердить отправку" })); });
  assert.deepEqual(sent, ["!literal action"], "the session boundary, not JSON, formats the outgoing prompt");
});

test("readonly assistant, wrong owner, user and custom messages cannot activate actions", () => {
  const scope = { sessionId: "owner", send: async () => { throw new Error("must not send"); } };
  const cases = [
    { message: assistant, sessionId: "owner" },
    { message: assistant, sessionId: "subagent", ompUiAction: scope },
    { message: { role: "user", content: markdown }, sessionId: "owner", ompUiAction: scope },
    { message: { role: "custom", customType: "advisor", content: markdown }, sessionId: "owner", ompUiAction: scope },
  ];
  for (const props of cases) {
    const view = render(React.createElement(MessageView, props));
    assert.equal(view.getByRole("button", { name: label }).disabled, true);
    cleanup();
  }
});

test("tool output never receives the assistant text action capability", () => {
  const scope = { sessionId: "owner", send: async () => { throw new Error("must not send"); } };
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tool", toolName: "read", input: { path: "output.md" } }] },
    sessionId: "owner", ompUiAction: scope,
    toolResults: new Map([["tool", { role: "toolResult", toolCallId: "tool", content: [{ type: "text", text: markdown }] }]]),
  }));
  fireEvent.click(view.container.querySelector("[aria-expanded]"));
  assert.equal(view.queryByRole("button", { name: label }), null);
});

test("streaming omp-ui remains source even with an active callback", () => {
  const scope = { sessionId: "owner", send: async () => true };
  const view = render(React.createElement(MessageView, { message: assistant, sessionId: "owner", ompUiAction: scope, isStreaming: true }));
  assert.equal(view.queryByRole("button", { name: label }), null);
  assert.match(view.container.querySelector("pre").textContent, /literal action/);
});

test("navigation and capability revocation invalidate a confirmation through memoized message views", () => {
  const sent = [];
  const scope = { sessionId: "owner", send: async (message) => { sent.push(message); return true; } };
  const view = render(React.createElement(MessageView, { message: assistant, sessionId: "owner", ompUiAction: scope }));
  fireEvent.click(view.getByRole("button", { name: label }));
  assert.ok(view.getByRole("dialog"));
  view.rerender(React.createElement(MessageView, { message: assistant, sessionId: "next", ompUiAction: scope }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(view.getByRole("button", { name: label }).disabled, true);
  view.rerender(React.createElement(MessageView, { message: assistant, sessionId: "owner", ompUiAction: scope }));
  fireEvent.click(view.getByRole("button", { name: label }));
  view.rerender(React.createElement(MessageView, { message: assistant, sessionId: "owner", ompUiAction: null }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(view.getByRole("button", { name: label }).disabled, true);
  assert.deepEqual(sent, []);
});

test("an inherited callback alone does not enable an ordinary Markdown consumer", () => {
  const view = render(React.createElement(OmpUiActionContext.Provider, { value: async () => true },
    React.createElement(MarkdownBody, null, markdown)));
  assert.equal(view.getByRole("button", { name: label }).disabled, true);
});

test("same-session readonly transitions retain form values but session navigation resets them", () => {
  const formSource = JSON.stringify({
    type: "form", title: "Параметры", message: "Use these parameters", submitLabel: "Проверить форму",
    fields: [{ name: "answer", label: "Ответ", type: "text", value: "" }],
  });
  const message = { role: "assistant", content: [{ type: "text", text: `\`\`\`omp-ui\n${formSource}\n\`\`\`` }] };
  const scope = { sessionId: "owner", send: async () => true };
  const view = render(React.createElement(MessageView, { message, sessionId: "owner", ompUiAction: scope }));
  fireEvent.change(view.getByLabelText("Ответ"), { target: { value: "keep my input" } });
  fireEvent.click(view.getByRole("button", { name: "Проверить форму" }));
  assert.ok(view.getByRole("dialog"));
  view.rerender(React.createElement(MessageView, { message, sessionId: "owner", ompUiAction: null }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(view.getByLabelText("Ответ").value, "keep my input");
  view.rerender(React.createElement(MessageView, { message, sessionId: "owner", ompUiAction: scope }));
  assert.equal(view.getByLabelText("Ответ").value, "keep my input");
  view.rerender(React.createElement(MessageView, { message, sessionId: "owner", ompUiAction: null }));
  view.rerender(React.createElement(MessageView, { message, sessionId: "next", ompUiAction: null }));
  assert.equal(view.getByLabelText("Ответ").value, "", "readonly-to-readonly navigation also changes owner");
});
