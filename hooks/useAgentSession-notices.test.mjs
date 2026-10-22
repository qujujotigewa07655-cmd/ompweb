import assert from "node:assert/strict";
import test from "node:test";
import { noticeReducer } from "./useAgentSession-notices.ts";

const empty = () => ({ visible: [], pending: [] });
const add = (state, message, type = "info", id = message) => (
  noticeReducer(state, { type: "add", notice: { id, message, type } })
);

test("a repeated notice does not stack an identical row", () => {
  let state = add(empty(), "MCP tools updated", "info", "first");
  state = add(state, "MCP tools updated", "info", "second");
  assert.deepEqual(state.visible.map((notice) => notice.id), ["first"]);
  assert.deepEqual(state.pending, []);
});

test("the same text under another severity is a separate notice", () => {
  let state = add(empty(), "Bad gateway", "warning");
  state = add(state, "Bad gateway", "error");
  assert.deepEqual(state.visible.map((notice) => notice.type), ["warning", "error"]);
});

test("a live duplicate is dropped, and a dismissed notice can appear again", () => {
  let state = add(empty(), "MCP tools updated", "info", "first");
  state = add(state, "MCP tools updated", "info", "duplicate");
  assert.deepEqual(state.visible.map((notice) => notice.id), ["first"], "the live duplicate is dropped");
  state = noticeReducer(state, { type: "remove", id: "first" });
  state = add(state, "MCP tools updated", "info", "second");
  assert.deepEqual(state.visible.map((notice) => notice.id), ["second"], "after dismissal the message appears again");
});
