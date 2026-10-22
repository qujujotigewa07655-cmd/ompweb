import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The indicator polls (`?light=1`) run every two seconds per open tab and read
// only the gauge and the run flags. The full snapshot joins the whole system
// prompt into the response, so shipping it on every poll is pure traffic.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/agent/[id]/route.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("GET returns the full state unless light=1, and never the prompt on a poll", async () => {
  const id = "indicator-projection";
  globalThis.__ompSessions ??= new Map();
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame: () => () => {},
    sendFrame() {},
    sendCommand: async (command) => command.type === "get_state"
      ? {
        sessionId: id, sessionFile: "/tmp/s.jsonl", isStreaming: true, isCompacting: false,
        autoCompactionEnabled: true, interruptMode: "immediate", steeringMode: "all",
        followUpMode: "all", messageCount: 3, queuedMessageCount: 0, todoPhases: [],
        systemPrompt: ["SYSTEM PROMPT BODY"], tokensPerSecond: 42, thinkingLevel: "off",
      }
      : {},
    dispose: async () => {},
  }, process.cwd());
  globalThis.__ompSessions.set(id, wrapper);
  try {
    const get = (query) => route.GET(
      new Request(`http://localhost/api/agent/${id}${query}`),
      { params: Promise.resolve({ id }) },
    );
    const full = await (await get("")).json();
    assert.equal(full.state.systemPrompt, "SYSTEM PROMPT BODY");
    assert.equal(full.state.tokensPerSecond, 42);

    const light = await (await get("?light=1")).json();
    assert.equal(light.state.systemPrompt, undefined, "a two-second poll must not carry the prompt");
    assert.equal(light.state.tokensPerSecond, 42);
    assert.equal(light.state.isStreaming, true);
    // Exactly the indicator fields, nothing else: a stray field here is
    // traffic the 2s poll pays for on every request.
    assert.deepEqual(Object.keys(light.state).sort(), [
      "isBashRunning", "isCompacting", "isPromptRunning", "isStreaming", "tokensPerSecond",
    ].sort());
    // The full response keeps everything it had.
    assert.ok("sessionId" in full.state, "the full state still carries the session id");
    assert.ok("systemPrompt" in full.state, "the full state still carries the prompt");
    assert.ok("messageCount" in full.state, "the full state still carries the counters");
  } finally {
    globalThis.__ompSessions.delete(id);
    await wrapper.destroyAndWait();
  }
});
