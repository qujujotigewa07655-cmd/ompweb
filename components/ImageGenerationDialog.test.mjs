import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ImageGenerationDialog } = await jiti.import("./ImageGenerationDialog.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("switching projects cancels generation, enables the new project, and ignores late saved images", async () => {
  const pending = Promise.withResolvers();
  let signal;
  const providers = [{ id: "openai", name: "GPT", model: "openai-codex/gpt-test", models: [{ id: "openai-codex/gpt-test", name: "GPT" }], available: true, reason: null }];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "POST") { signal = options.signal; return pending.promise; }
    return Response.json({ providers, images: [] });
  };
  const props = { onClose() {}, onOpenFile() {} };
  const view = render(React.createElement(ImageGenerationDialog, { ...props, cwd: "/project-a" }));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Create", exact: true }).disabled, false));
  fireEvent.change(screen.getByLabelText("Image description"), { target: { value: "Old project image" } });
  fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
  await screen.findByRole("button", { name: "Generating…", exact: true });
  view.rerender(React.createElement(ImageGenerationDialog, { ...props, cwd: "/project-b" }));
  assert.equal(signal.aborted, true);
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Create", exact: true }).disabled, false));
  await act(async () => { pending.resolve(Response.json({ images: [{ path: "/project-a/old.png", url: "/old.png", downloadUrl: "/old.png", prompt: "Stale saved image", provider: "openai", model: providers[0].model, createdAt: "2026-10-21" }] })); });
  assert.equal(screen.queryByText("Stale saved image"), null);
  assert.equal(screen.getByRole("button", { name: "Create", exact: true }).disabled, false);
});
