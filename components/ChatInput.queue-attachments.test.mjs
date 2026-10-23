import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

const KEY = "queue-attachments";
// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const originalFetch = globalThis.fetch;

// Same stand-in as ChatInput.clipboard-image.test.mjs: jsdom's FileReader
// brand-checks against its own realm's Blob; the composer only needs
// readAsDataURL -> `result`.
const previousFileReader = globalThis.FileReader;
class TestFileReader {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  cleanup();
  clearDraft(KEY);
  localStorage.clear();
  delete window.matchMedia;
  globalThis.FileReader = previousFileReader;
  globalThis.fetch = originalFetch;
  clearDraft("other-chat");
});

/** A composer mid-run with an image and a text file attached through the picker path. */
async function renderRunningWithAttachments({ queued = true } = {}) {
  const calls = [];
  // Images are the last argument of every queue callback, which resolves
  // false when omp refused the message.
  const record = (name) => async (message, ...rest) => { calls.push({ name, message, images: rest.at(-1) }); return queued; };
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming: true,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
  }));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "attaching is allowed while the agent runs");
    assert.equal(draft?.files.length, 1);
  });
  return calls;
}

function assertQueuedWithAttachments(call, text) {
  assert.ok(call.message.startsWith(text), "typed text leads the message");
  assert.match(call.message, /Attached file: notes\.txt\n```[^\n]*\nhello\n```/, "text file is folded in");
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run queues a follow-up with the attached image and text file, then clears them", async () => {
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  // Queueing is the default submit-during-run behavior: it is what survives a
  // `!!` shell command owning the session (see lib/rpc-manager.ts).
  assert.equal(calls[0].name, "onFollowUp", "the default submit-during-run behavior queues");
  assertQueuedWithAttachments(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

test("a stored Steer preference still steers Enter during a run", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "an explicit stored choice stays a steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("attachments alone turn Stop into Queue, which queues them as a follow-up", async () => {
  const calls = await renderRunningWithAttachments();
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onFollowUp");
  assertQueuedWithAttachments(calls[0], "Attached file:");
});

test("a queued web slash command is expanded and keeps the attachments", async () => {
  const { expandWebSlashCommand } = await jiti.import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onPromptWithStreamingBehavior");
  assertQueuedWithAttachments(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

test("a refused follow-up goes back whole to its draft, ahead of what was typed meanwhile", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed meanwhile" } });
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY)?.value, `${calls[0].message}\n\ntyped meanwhile`, "the text, file contents included, comes back too");
  assert.equal(screen.getByRole("textbox").value, `${calls[0].message}\n\ntyped meanwhile`);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await jiti.import("@/lib/image-attachments");
  const { recoverDraft } = await jiti.import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});

test("images and documents share ten attachment slots, including pending reads", async () => {
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ref, draftKey: KEY, onSend() {}, onAbort() {}, isStreaming: false }));
  await act(async () => {
    ref.current.addFiles(Array.from({ length: 10 }, (_, index) => new File([Buffer.from(PNG, "base64")], `${index}.png`, { type: "image/png" })));
    ref.current.addFiles([new File(["extra"], "extra.txt", { type: "text/plain" })]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 10));
  assert.equal(getDraft(KEY)?.files.length, 0);
});

test("text past the remaining inline budget uploads instead of disappearing", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/stt?")) return Response.json({ jobs: [] });
    calls.push({ url, options });
    if (options.method === "PUT") return Response.json({ received: options.body.size });
    const body = JSON.parse(options.body);
    if (body.operation === "begin") {
      assert.deepEqual(body.files.map(file => file.name), ["second.txt"]);
      return Response.json({ id: "text-budget" });
    }
    assert.equal(body.operation, "commit");
    return Response.json({ attachments: [{ name: "second.txt", mimeType: "text/plain", size: 3 * 1024 * 1024, path: "/workspace/second.txt", textPath: "/workspace/second-sections.txt" }] });
  };
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ref, draftKey: KEY, cwd: "/workspace", onSend() {}, onAbort() {}, isStreaming: false }));
  await act(async () => {
    ref.current.addFiles([
      new File(["a".repeat(3 * 1024 * 1024)], "first.txt", { type: "text/plain" }),
      new File(["b".repeat(3 * 1024 * 1024)], "second.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.files.length, 2));
  const files = getDraft(KEY).files;
  assert.equal(files[0].content.length, 3 * 1024 * 1024);
  assert.equal(files[1].path, "/workspace/second.txt");
  assert.equal(files[1].content, "");
  assert.equal(calls.filter(call => call.options.method === "PUT").length, 3);
});

for (const transition of ["switch", "unmount"]) {
  test(`a composer ${transition} aborts an unfinished upload and cannot attach to another chat`, async () => {
    let signal;
    globalThis.fetch = (url, options) => {
      if (String(url).startsWith("/api/stt?")) return Promise.resolve(Response.json({ jobs: [] }));
      const { promise, reject } = Promise.withResolvers();
      signal = options.signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      return promise;
    };
    const ref = React.createRef();
    const props = { ref, draftKey: KEY, cwd: "/workspace", onSend() {}, onAbort() {}, isStreaming: false };
    const view = render(React.createElement(ChatInput, props));
    act(() => { ref.current.addFiles([new File(["document"], "report.pdf", { type: "application/pdf" })]); });
    await waitFor(() => assert.ok(signal));
    await act(async () => {
      if (transition === "switch") view.rerender(React.createElement(ChatInput, { ...props, draftKey: "other-chat" }));
      else view.unmount();
    });
    assert.equal(signal.aborted, true);
    assert.equal(getDraft("other-chat"), null);
  });
}

for (const queued of [false, true]) {
  test(`a restored uploaded image hydrates its derivative before ${queued ? "queue" : "send"}, preserving its original path`, async () => {
    const { setDraft } = await jiti.import("@/lib/draft-store");
    const image = { data: "", mimeType: "image/jpeg", path: "/workspace/original.png", visionPath: "/workspace/vision.jpg", name: "original.png", size: 6 * 1024 * 1024 };
    setDraft(KEY, { value: "Look", images: [image], files: [] });
    const requests = [];
    globalThis.fetch = async url => {
      if (String(url).startsWith("/api/stt?")) return Response.json({ jobs: [] });
      requests.push(url);
      return new Response(Buffer.from(PNG, "base64"), { headers: { "Content-Type": "image/jpeg" } });
    };
    const calls = [];
    const record = async (message, images) => { calls.push({ message, images }); return !queued; };
    render(React.createElement(ChatInput, { draftKey: KEY, cwd: "/workspace", onSend: record, onFollowUp: record, onAbort() {}, isStreaming: queued }));
    assert.match(document.querySelector("img").getAttribute("src"), /vision\.jpg/);
    fireEvent.click(screen.getByRole("button", { name: queued ? /queue/i : /^send$/i }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(requests, ["/api/files/workspace/vision.jpg?type=read"]);
    assert.equal(calls[0].images[0].data, PNG);
    assert.match(calls[0].message, /Original path: "\/workspace\/original\.png"/);
    if (queued) {
      await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
      assert.equal(getDraft(KEY).images[0].visionPath, image.visionPath);
      assert.equal(getDraft(KEY).images[0].path, image.path);
    } else await waitFor(() => assert.equal(getDraft(KEY), null));
  });
}

test("failed image hydration keeps the draft and sends nothing", async () => {
  const { setDraft } = await jiti.import("@/lib/draft-store");
  const image = { data: "", mimeType: "image/jpeg", path: "/workspace/original.png", visionPath: "/workspace/vision.jpg" };
  setDraft(KEY, { value: "Keep me", images: [image], files: [] });
  globalThis.fetch = async url => String(url).startsWith("/api/stt?") ? Response.json({ jobs: [] }) : new Response("missing", { status: 404 });
  let sends = 0;
  render(React.createElement(ChatInput, { draftKey: KEY, onSend() { sends++; }, onAbort() {}, isStreaming: false }));
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  assert.match((await screen.findByRole("alert")).textContent, /could not be read/i);
  assert.equal(sends, 0);
  assert.equal(getDraft(KEY).value, "Keep me");
  assert.equal(getDraft(KEY).images[0].visionPath, image.visionPath);
});

test("switching chats during image hydration cancels dispatch to either chat", async () => {
  const { setDraft } = await jiti.import("@/lib/draft-store");
  setDraft(KEY, { value: "Old chat", images: [{ data: "", mimeType: "image/jpeg", path: "/workspace/original.png", visionPath: "/workspace/vision.jpg" }], files: [] });
  let signal;
  let sends = 0;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("/api/stt?")) return Promise.resolve(Response.json({ jobs: [] }));
    const { promise, reject } = Promise.withResolvers();
    signal = options.signal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    return promise;
  };
  const props = { draftKey: KEY, onSend() { sends++; }, onAbort() {}, isStreaming: false };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.ok(signal));
  await act(async () => { view.rerender(React.createElement(ChatInput, { ...props, draftKey: "other-chat" })); });
  assert.equal(signal.aborted, true);
  assert.equal(sends, 0);
  assert.equal(getDraft(KEY).value, "Old chat");
  assert.equal(getDraft("other-chat"), null);
});

test("a large image with empty browser MIME stays attached by original and vision paths", async () => {
  const image = { name: "large.png", size: 6 * 1024 * 1024, path: "/workspace/large.png", visionPath: "/workspace/vision.jpg", mimeType: "image/png", image: { data: PNG, mimeType: "image/jpeg" } };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/stt?")) return Response.json({ jobs: [] });
    if (options.method === "PUT") return Response.json({ received: options.body.size });
    const body = JSON.parse(options.body);
    return Response.json(body.operation === "begin" ? { id: "large-image" } : { attachments: [image] });
  };
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ref, draftKey: KEY, cwd: "/workspace", onSend() {}, onAbort() {}, isStreaming: false }));
  await act(async () => { ref.current.addFiles([new File([new Uint8Array(image.size)], image.name)]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  assert.equal(getDraft(KEY).images[0].path, image.path);
  assert.equal(getDraft(KEY).images[0].visionPath, image.visionPath);
  assert.equal(getDraft(KEY).images[0].size, image.size);
  assert.equal(getDraft(KEY).images[0].data, "");
  assert.match(document.querySelector("img").getAttribute("src"), /vision\.jpg/);
});

test("a prompt the session refuses after hydration keeps its draft and says so", async () => {
  const { setDraft } = await jiti.import("@/lib/draft-store");
  const image = { data: "", mimeType: "image/jpeg", path: "/workspace/original.png", visionPath: "/workspace/vision.jpg", name: "original.png", size: 6 * 1024 * 1024 };
  setDraft(KEY, { value: "Keep this", images: [image], files: [] });
  let release;
  globalThis.fetch = (url) => String(url).startsWith("/api/stt?")
    ? Promise.resolve(Response.json({ jobs: [] }))
    : new Promise((resolve) => { release = resolve; });
  let sends = 0;
  render(React.createElement(ChatInput, {
    draftKey: KEY,
    onSend: async () => { sends++; return false; },
    onAbort() {},
    isStreaming: false,
  }));
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.ok(release));
  await act(async () => { release(new Response(new Uint8Array([0]), { headers: { "Content-Type": "image/jpeg" } })); });
  assert.match((await screen.findByRole("alert")).textContent, /not sent/i);
  assert.equal(sends, 1);
  assert.equal(getDraft(KEY)?.value, "Keep this");
  assert.equal(getDraft(KEY)?.images[0]?.visionPath, image.visionPath);
  assert.equal(screen.getByRole("textbox").value, "Keep this");
});

for (const edit of ["none", "text", "document", "image", "pending document"]) {
  test(`an accepted send preserves subsequent composer edits: ${edit}`, async () => {
    const accepted = Promise.withResolvers();
    const ref = React.createRef();
    let sends = 0;
    render(React.createElement(ChatInput, {
      ref, draftKey: KEY, isStreaming: false, onAbort() {},
      onSend: () => { sends++; return accepted.promise; },
    }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sent text" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(sends, 1));
    let finishRead;
    if (edit === "text") {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "next question" } });
    } else if (edit !== "none") {
      const file = edit === "image"
        ? new File([Buffer.from(PNG, "base64")], "next.png", { type: "image/png" })
        : new File(["next document"], "next.txt", { type: "text/plain" });
      if (edit === "pending document") {
        const reading = Promise.withResolvers();
        file.text = () => reading.promise;
        finishRead = () => reading.resolve("next document");
      }
      await act(async () => { ref.current.addFiles([file]); });
      if (!finishRead) await waitFor(() => assert.equal(edit === "image" ? getDraft(KEY)?.images.length : getDraft(KEY)?.files.length, 1));
    }
    await act(async () => { accepted.resolve(true); });
    if (finishRead) {
      await act(async () => { finishRead(); });
      await waitFor(() => assert.equal(getDraft(KEY)?.files.length, 1));
    }
    if (edit === "none") {
      assert.equal(screen.getByRole("textbox").value, "");
      assert.equal(getDraft(KEY), null);
    } else {
      assert.equal(screen.getByRole("textbox").value, edit === "text" ? "next question" : "sent text");
      if (edit === "image") assert.equal(getDraft(KEY)?.images[0]?.data, PNG);
      else if (edit !== "text") assert.equal(getDraft(KEY)?.files[0]?.content, "next document");
    }
  });
}

for (const type of ["image/svg+xml", ""]) {
  test(`SVG is attached as text rather than a model image (${type || "empty MIME"})`, async () => {
    const ref = React.createRef();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>vector marker</text></svg>';
    render(React.createElement(ChatInput, { ref, draftKey: KEY, isStreaming: false, onSend() {}, onAbort() {} }));
    await act(async () => { ref.current.addFiles([new File([svg], "diagram.svg", { type })]); });
    await waitFor(() => assert.equal(getDraft(KEY)?.files[0]?.content, svg));
    assert.equal(getDraft(KEY).images.length, 0);
  });
}

for (const order of ["document first", "text first"]) {
  test(`restoring a draft keeps inline text beside an uploaded document (${order})`, async () => {
    const { setDraft } = await jiti.import("@/lib/draft-store");
    const document = { name: "report.pdf", mimeType: "application/pdf", size: 3 * 1024 * 1024, path: "/workspace/report.pdf", textPath: "/workspace/report.txt", content: "" };
    const text = { name: "notes.txt", mimeType: "text/plain", size: 3 * 1024 * 1024, content: "t".repeat(3 * 1024 * 1024) };
    setDraft(KEY, { value: "", images: [], files: order === "document first" ? [document, text] : [text, document] });
    render(React.createElement(ChatInput, { draftKey: KEY, onSend() {}, onAbort() {}, isStreaming: false }));
    await waitFor(() => assert.deepEqual(getDraft(KEY)?.files.map((file) => file.name).sort(), ["notes.txt", "report.pdf"]));
    assert.equal(screen.getAllByRole("button", { name: /remove file/i }).length, 2);
  });
}

test("an oversized streamed derivative cannot consume the draft or dispatch a prompt", async () => {
  const { setDraft } = await jiti.import("@/lib/draft-store");
  setDraft(KEY, { value: "Keep budget", images: [{ data: "", mimeType: "image/jpeg", path: "/workspace/large.png", visionPath: "/workspace/vision.jpg" }], files: [] });
  globalThis.fetch = async url => String(url).startsWith("/api/stt?") ? Response.json({ jobs: [] }) : new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/jpeg" } });
  let sends = 0;
  render(React.createElement(ChatInput, { draftKey: KEY, onSend() { sends++; }, onAbort() {}, isStreaming: false }));
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  assert.match((await screen.findByRole("alert")).textContent, /exceeds the 5 MB/i);
  assert.equal(sends, 0);
  assert.equal(getDraft(KEY).value, "Keep budget");
  assert.equal(getDraft(KEY).images[0].visionPath, "/workspace/vision.jpg");
});
