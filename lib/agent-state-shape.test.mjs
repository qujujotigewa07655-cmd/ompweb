import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { indicatorState, stateWithoutSystemPrompt } = await jiti.import("./agent-state-shape.ts");

const fullState = {
  systemPrompt: "x".repeat(133_000),
  model: { provider: "ollama-cloud", modelId: "deepseek-v4.1-flash:1017" },
  contextUsage: { percent: 12, contextWindow: 1_000_000, tokens: 120_000 },
  tokensPerSecond: 41.5,
  isStreaming: true,
  isPromptRunning: true,
  isBashRunning: false,
  isCompacting: false,
  usageLimit: null,
  queuedMessages: [],
  todoPhases: [{ name: "Analysis", items: [] }],
};

test("drops only the joined system prompt from a polled state", () => {
  const shaped = stateWithoutSystemPrompt(fullState);
  assert.equal("systemPrompt" in shaped, false);
  // Everything the reconcile/terminal resync reads survives.
  assert.deepEqual(shaped.model, fullState.model);
  assert.deepEqual(shaped.contextUsage, fullState.contextUsage);
  assert.deepEqual(shaped.todoPhases, fullState.todoPhases);
  assert.equal(shaped.tokensPerSecond, 41.5);
  // The input object is not mutated: the same snapshot serves other readers.
  assert.equal(fullState.systemPrompt.length, 133_000);
});

test("omitPrompt projection is what the reconcilers ask for", () => {
  const shaped = stateWithoutSystemPrompt(fullState);
  // The 15 s reconcile, terminal resync and model-change sync request
  // `?omitPrompt=1`: the mount load and the System panel own the prompt text,
  // so this projection must not spend 133 KB re-sending it.
  assert.ok(JSON.stringify(shaped).length < 2_000);
  assert.equal(shaped.queuedMessages.length, 0);
  assert.deepEqual(shaped.todoPhases, fullState.todoPhases);
});

test("leaves a state without a system prompt untouched and ignores null", () => {
  const without = { ...fullState };
  delete without.systemPrompt;
  assert.deepEqual(stateWithoutSystemPrompt(without), without);
  assert.deepEqual(stateWithoutSystemPrompt(null), {});
});

test("light state keeps exactly the indicator fields", () => {
  const light = indicatorState(fullState);
  assert.deepEqual(Object.keys(light).sort(), [
    "isBashRunning", "isCompacting", "isPromptRunning", "isStreaming", "tokensPerSecond", "usageLimit",
  ]);
  assert.equal(light.tokensPerSecond, 41.5);
  assert.equal(light.usageLimit, null);
  // A payload this small is the point: 148 bytes against 133 KB.
  assert.ok(JSON.stringify(light).length < 200);
});
