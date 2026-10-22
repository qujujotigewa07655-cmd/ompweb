import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false });
const { readSubscriptionImages, validateImageGeneration } = await jiti.import("./image-generation.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("generation accepts only models of the selected subscription provider", () => {
  const valid = { provider: "openai", model: "openai-codex/gpt-6.1-sol", prompt: "A cat", cwd: "/project" };
  for (const invalid of [
    { ...valid, provider: "openrouter" },
    { ...valid, model: "openai/gpt-image-2" },
    { ...valid, provider: "gemini", model: "google/gemini-2.5-flash-image" },
    { ...valid, provider: "gemini", model: "google-antigravity/claude-sonnet" },
    { ...valid, model: "openai-codex/gpt-6/../../models" },
    { ...valid, prompt: " " },
  ]) assert.throws(() => validateImageGeneration(invalid));
  assert.equal(validateImageGeneration({ ...valid, provider: "gemini", model: "google-antigravity/gemini-3-pro-image" }).provider, "gemini");
});

test("native hosted and Cloud Code Assist responses preserve image bytes and reject text-only replies", async () => {
  const decode = (provider, payload) => readSubscriptionImages(stream(`data: ${JSON.stringify(provider === "openai" ? { type: "response.completed", response: payload } : payload)}\n\n`), provider, new AbortController().signal);
  const codex = await decode("openai", { output: [{ type: "image_generation_call", result: png }] });
  const gemini = await decode("gemini", { response: { candidates: [{ content: { parts: [{ text: "Here is the image" }, { inlineData: { data: png, mimeType: "image/png" } }] } }] } });
  assert.deepEqual(gemini, codex);
  assert.deepEqual(Buffer.from(codex[0].data, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(codex[0].mimeType, "image/png");
  for (const [provider, body] of [
    ["openai", { output: [{ type: "message", content: [{ type: "refusal", refusal: "Refused" }] }] }],
    ["openai", { output: [{ type: "image_generation_call", result: "not base64" }] }],
    ["gemini", { response: { candidates: [{ content: { parts: [{ text: "Refused" }] } }] } }],
    ["gemini", { response: { candidates: [{ content: { parts: [{ inlineData: { data: png, mimeType: "text/html" } }] } }] } }],
  ]) await assert.rejects(decode(provider, body), /returned no image/);
});

function stream(events, size = 7) {
  const bytes = new TextEncoder().encode(events);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}

test("fragmented SSE handles UTF-8/CRLF and does not duplicate Codex completed images", async () => {
  const item = { type: "image_generation_call", result: png };
  const events = [
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item, { type: "message", content: [{ type: "output_text", text: "Done" }] }] } },
  ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const images = await readSubscriptionImages(stream(events, 1), "openai", new AbortController().signal);
  assert.deepEqual(images, [{ data: png, mimeType: "image/png" }]);
  const gemini = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Picture" }, { inlineData: { data: png, mimeType: "image/png" } }] } }] } })}\n\n`;
  assert.deepEqual(await readSubscriptionImages(stream(gemini), "gemini", new AbortController().signal), images);
});

test("SSE failures and cancelled responses cannot become successful images", async () => {
  await assert.rejects(readSubscriptionImages(stream('data: {"type":"response.failed"}\n\n'), "openai", new AbortController().signal), /refused/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(readSubscriptionImages(stream("data: [DONE]\n\n"), "gemini", cancelled.signal), { name: "AbortError" });
});

test("subscription SSE does not depend on Content-Type", async () => {
  const event = { type: "response.completed", response: { output: [{ type: "image_generation_call", result: png }] } };
  const bytes = new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`);
  for (const contentType of [null, "application/json"]) {
    const response = new Response(bytes, { headers: contentType ? { "Content-Type": contentType } : {} });
    assert.deepEqual(await readSubscriptionImages(response, "openai", new AbortController().signal), [{ data: png, mimeType: "image/png" }]);
  }
});
