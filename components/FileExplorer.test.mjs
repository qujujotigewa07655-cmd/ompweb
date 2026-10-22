import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { cleanup, fireEvent, render as renderUI, screen, waitFor, act } from "@testing-library/react/pure.js";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      onOpenFile() {},
      ...props,
    }),
  );
}

test("renders the search input only while the search panel is open", () => {
  const closed = render();
  assert.doesNotMatch(closed, /aria-label="(Search files|fileExplorer\.searchFiles)"/);

  const open = render({ fileSearchOpen: true });
  assert.match(open, /aria-label="(Search files|fileExplorer\.searchFiles)"/);
  assert.match(open, /placeholder="(Search files\.\.\.|fileExplorer\.searchPlaceholder)"/);
});

test("keeps the regular file tree visible while the search query is empty", () => {
  // An open panel with no query must not hide the tree behind an empty
  // search-results state.
  const open = render({ fileSearchOpen: true });
  assert.match(open, /role="tree"/);
  assert.match(open, /(Loading files\.\.\.|fileExplorer\.loadingFiles)/);
  assert.doesNotMatch(open, /(No matching files|fileExplorer\.noMatchingFiles)/);
});

test("explorer uploads a 50 MiB original through chunks and displays progress and mixed results", async () => {
  const commit = Promise.withResolvers();
  const requests = [];
  let bytes = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("type=list")) return Response.json({ entries: [] });
    if (String(url).startsWith("/api/git/status")) return Response.json({ isGitRepository: false, files: [] });
    requests.push({ url, options });
    if (String(url).includes("type=upload-check")) return Response.json({ conflicts: [] });
    assert.ok(String(url).startsWith("/api/attachments"));
    if (options.method === "PUT") { bytes += options.body.size; return Response.json({}); }
    if (options.method === "DELETE") return Response.json({});
    const body = JSON.parse(options.body);
    if (body.operation === "begin") {
      assert.equal(body.directory, "/tmp/project");
      assert.equal(body.attachments, false);
      assert.equal(body.strategy, "error");
      assert.equal(body.files[0].size, 50 * 1024 * 1024);
      return Response.json({ id: "explorer-batch" });
    }
    assert.equal(body.operation, "commit");
    return commit.promise;
  };
  const mentions = [];
  const view = renderUI(React.createElement(FileExplorer, { cwd: "/tmp/project", onOpenFile() {}, onAtMentions: paths => mentions.push(paths) }));
  const files = [
    new File([new Uint8Array(50 * 1024 * 1024)], "large.bin"),
    new File(["skip"], "existing.txt"),
    new File(["bad"], "blocked.txt"),
  ];
  fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files } });
  await screen.findByRole("status", { name: /100%/ });
  assert.equal(bytes, files.reduce((total, file) => total + file.size, 0));
  assert.equal(requests.filter(request => request.options.method === "PUT").length > 1, true);
  assert.deepEqual(JSON.parse(requests[0].options.body).fileNames, files.map(file => file.name));
  await act(async () => { commit.resolve(Response.json({ uploaded: ["large.bin"], skipped: ["existing.txt"], errors: [{ name: "blocked.txt", error: "Permission denied" }] }, { status: 207 })); });
  await screen.findByLabelText("1 uploaded");
  assert.ok(screen.getByLabelText("1 skipped"));
  assert.ok(screen.getByLabelText("1 failed"));
  assert.ok(screen.getByTitle("Permission denied"));
  fireEvent.click(screen.getByRole("button", { name: "Add uploaded file to chat" }));
  assert.deepEqual(mentions, [["large.bin"]]);
});

for (const [button, strategy] of [["Replace", "overwrite"], ["Skip existing", "skip"]]) {
  test(`explorer conflict precheck waits for ${button} before uploading`, async () => {
    const strategies = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("type=list")) return Response.json({ entries: [] });
      if (String(url).startsWith("/api/git/status")) return Response.json({ isGitRepository: false, files: [] });
      if (String(url).includes("type=upload-check")) return Response.json({ conflicts: ["same.txt"], nonReplaceable: [] });
      assert.ok(String(url).startsWith("/api/attachments"));
      if (options.method === "PUT" || options.method === "DELETE") return Response.json({});
      const body = JSON.parse(options.body);
      if (body.operation === "begin") { strategies.push(body.strategy); return Response.json({ id: "conflict-batch" }); }
      return Response.json(strategy === "skip" ? { skipped: ["same.txt"] } : { uploaded: ["same.txt"] });
    };
    const view = renderUI(React.createElement(FileExplorer, { cwd: "/tmp/project", onOpenFile() {} }));
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [new File(["new"], "same.txt")] } });
    await screen.findByText("1 file already exists: same.txt");
    assert.deepEqual(strategies, []);
    fireEvent.click(screen.getByRole("button", { name: button, exact: true }));
    await screen.findByLabelText(strategy === "skip" ? "1 skipped" : "1 uploaded");
    assert.deepEqual(strategies, [strategy]);
  });
}

test("explorer exposes a raced upload conflict and Cancel sends no retry", async () => {
  const strategies = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("type=list")) return Response.json({ entries: [] });
    if (String(url).startsWith("/api/git/status")) return Response.json({ isGitRepository: false, files: [] });
    if (String(url).includes("type=upload-check")) return Response.json({ conflicts: [] });
    assert.equal(url, "/api/attachments");
    strategies.push(JSON.parse(options.body).strategy);
    return Response.json({ conflicts: ["raced.txt"], nonReplaceable: ["raced.txt"] }, { status: 409 });
  };
  const view = renderUI(React.createElement(FileExplorer, { cwd: "/tmp/project", onOpenFile() {} }));
  fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [new File(["new"], "raced.txt")] } });
  await screen.findByText("Cannot replace: raced.txt");
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await waitFor(() => assert.equal(screen.queryByText("Cannot replace: raced.txt"), null));
  assert.deepEqual(strategies, ["error"]);
});
