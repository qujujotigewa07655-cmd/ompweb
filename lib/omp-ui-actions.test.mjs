import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createOmpUiActionHandler, formatOmpUiActionMessage } = await jiti.import("./omp-ui-actions.ts");

const prefix = "OMP UI — действие пользователя:\n";

test("action text cannot enter shell or slash-command dispatch", async () => {
  const sent = [];
  let busy = false;
  const send = createOmpUiActionHandler({
    canSend: () => true,
    isBusy: () => busy,
    send: async (message) => { sent.push(["send", message]); return true; },
    followUp: async (message) => { sent.push(["followUp", message]); return true; },
  });
  assert.equal(await send("!rm -rf /"), true);
  busy = true;
  assert.equal(await send("/compact"), true);
  assert.deepEqual(sent, [["send", `${prefix}!rm -rf /`], ["followUp", `${prefix}/compact`]]);
  assert.equal(formatOmpUiActionMessage("form\n{\"count\":2}"), `${prefix}form\n{\"count\":2}`);
});

test("one owner capability suppresses double sends across cards and recovers after failures", async () => {
  let release;
  let calls = 0;
  let fail = false;
  const send = createOmpUiActionHandler({
    canSend: () => true,
    isBusy: () => false,
    send: async () => {
      calls++;
      if (fail) throw new Error("transport failed");
      return new Promise((resolve) => { release = resolve; });
    },
    followUp: async () => { throw new Error("unexpected follow-up"); },
  });
  const pending = send("first");
  assert.equal(await send("second"), false);
  assert.equal(calls, 1);
  release(true);
  assert.equal(await pending, true);
  fail = true;
  await assert.rejects(send("third"), /transport failed/);
  await assert.rejects(send("fourth"), /transport failed/);
  assert.equal(calls, 3);
});

test("a revoked session owner cannot dispatch a pending confirmation", async () => {
  let owner = "original";
  let writable = true;
  const sent = [];
  const send = createOmpUiActionHandler({
    canSend: () => owner === "original" && writable,
    isBusy: () => false,
    send: async (message) => { sent.push(message); return true; },
    followUp: async (message) => { sent.push(message); return true; },
  });
  writable = false;
  await assert.rejects(send("while disconnected"), /Действие недоступно/);
  writable = true;
  owner = "next";
  await assert.rejects(send("after navigation"), /Действие недоступно/);
  assert.deepEqual(sent, []);
});
