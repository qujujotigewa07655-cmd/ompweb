import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { handleAttachmentUpload } = await jiti.import("./file-upload-server.ts");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".image-upload-test-"));
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); globalThis.__piAllowedRootsCache = undefined; });
  return root;
}
async function post(body) {
  return handleAttachmentUpload(new Request("http://local/api/attachments", { method: "POST", body: JSON.stringify(body) }));
}

test("vision derivative preserves the original and full-frame aspect ratio", async t => {
  const root = await fixture(t);
  const source = path.join(root, "source.png");
  const made = spawnSync("python3", ["-B", "-c", "from PIL import Image; import sys; Image.new('RGB',(2400,1200),(20,80,160)).save(sys.argv[1])", source], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const bytes = await fs.readFile(source);
  const begin = await post({ operation: "begin", directory: root, attachments: true, files: [{ name: "wide.png", size: bytes.length, mimeType: "image/png" }] });
  assert.equal(begin.status, 200);
  const { id } = await begin.json();
  const sent = await handleAttachmentUpload(new Request(`http://local/api/attachments?id=${id}&index=0&offset=0`, { method: "PUT", body: bytes }));
  assert.equal(sent.status, 200);
  const committed = await post({ operation: "commit", id });
  assert.equal(committed.status, 200, await committed.clone().text());
  const [attachment] = (await committed.json()).attachments;
  assert.deepEqual(await fs.readFile(attachment.path), bytes);
  assert.ok(Buffer.from(attachment.image.data, "base64").length <= 400 * 1024);
  const dimensions = spawnSync("python3", ["-B", "-c", "from PIL import Image; import json,sys; print(json.dumps(Image.open(sys.argv[1]).size))", attachment.visionPath], { encoding: "utf8" });
  assert.equal(dimensions.status, 0, dimensions.stderr);
  assert.deepEqual(JSON.parse(dimensions.stdout), [1280, 640]);
});

test("explicit cancellation interrupts an in-flight chunk and removes its staging directory", async t => {
  const root = await fixture(t);
  const begin = await post({ operation: "begin", directory: root, files: [{ name: "slow.txt", size: 2, mimeType: "text/plain" }] });
  const { id } = await begin.json();
  const { promise: reading, resolve } = Promise.withResolvers();
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; if (pulls === 1) controller.enqueue(new Uint8Array([65])); else resolve(); } });
  const pending = handleAttachmentUpload(new Request(`http://local/api/attachments?id=${id}&index=0&offset=0`, { method: "PUT", body, duplex: "half" }));
  await reading;
  const cancelled = await handleAttachmentUpload(new Request(`http://local/api/attachments?id=${id}`, { method: "DELETE" }));
  assert.equal(cancelled.status, 200);
  assert.equal((await pending).status, 400);
  assert.deepEqual(await fs.readdir(root), []);
});
