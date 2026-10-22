import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { uploadFileBatch } = await jiti.import("./file-upload-client.ts");
const { MAX_UPLOAD_FILE_BYTES, UPLOAD_CHUNK_BYTES } = await jiti.import("./file-upload-limits.ts");

test("browser transport accepts ten boundary-sized originals using small chunks, not file-body JSON", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let declared = [];
  let total = 0;
  let chunks = 0;
  const part = new Blob([new Uint8Array(UPLOAD_CHUNK_BYTES)]);
  globalThis.fetch = async (_url, options) => {
    if (options.method === "PUT") {
      assert.ok(options.body instanceof Blob);
      assert.ok(options.body.size <= UPLOAD_CHUNK_BYTES);
      total += options.body.size;
      chunks++;
      return Response.json({});
    }
    assert.ok(options.body.length < 4096, "manifest and commit remain small");
    const body = JSON.parse(options.body);
    if (body.operation === "begin") { declared = body.files; return Response.json({ id: "batch" }); }
    return Response.json({ uploaded: declared.map(file => file.name) });
  };
  // Disk-backed browser Files expose size and lazy slicing; no 500 MiB test allocation.
  const files = Array.from({ length: 10 }, (_, index) => ({ name: `${index}.txt`, size: MAX_UPLOAD_FILE_BYTES, type: "text/plain", slice: () => part }));
  const result = await uploadFileBatch(files, { directory: "/project" });
  assert.equal(result.status, 200);
  assert.equal(declared.length, 10);
  assert.equal(total, 10 * MAX_UPLOAD_FILE_BYTES);
  assert.equal(chunks, 500);
});

test("browser preflight rejects an invalid selection without contacting the server", async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  const options = { directory: "/project" };
  await assert.rejects(uploadFileBatch(Array.from({ length: 11 }, () => ({ size: 1 })), options), /at most 10/);
  await assert.rejects(uploadFileBatch([{ size: 1 }, { size: MAX_UPLOAD_FILE_BYTES + 1 }], options), /50 MiB/);
  assert.equal(calls, 0);
});
