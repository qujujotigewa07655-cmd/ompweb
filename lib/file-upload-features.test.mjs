import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { validateUploadBatch, MAX_UPLOAD_FILE_BYTES, UPLOAD_CHUNK_BYTES } = await jiti.import("./file-upload-limits.ts");
const { handleAttachmentUpload } = await jiti.import("./file-upload-server.ts");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".upload-feature-test-"));
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); globalThis.__piAllowedRootsCache = undefined; });
  return root;
}
function post(body, signal) {
  return handleAttachmentUpload(new Request("http://local/api/attachments", { method: "POST", body: JSON.stringify(body), signal }));
}
async function begin(root, files, attachments = false, strategy = "error") {
  const response = await post({ operation: "begin", directory: root, files, attachments, strategy });
  return { status: response.status, ...await response.json() };
}
function put(id, index, offset, data, headers) {
  return handleAttachmentUpload(new Request(`http://local/api/attachments?id=${id}&index=${index}&offset=${offset}`, { method: "PUT", body: data, headers }));
}

test("ten exact-boundary originals fit; eleven or one oversized file reject the entire batch", async t => {
  const root = await workspace(t);
  const files = Array.from({ length: 10 }, (_, index) => ({ name: `${index}.txt`, size: MAX_UPLOAD_FILE_BYTES, mimeType: "text/plain" }));
  assert.equal(validateUploadBatch(files), null);
  assert.ok(validateUploadBatch([...files, files[0]]));
  assert.ok(validateUploadBatch([{ size: MAX_UPLOAD_FILE_BYTES + 1 }, { size: 1 }]));
  assert.ok(validateUploadBatch([{ size: 1 }], 10));
  const rejected = await begin(root, [...files, { name: "eleven.txt", size: 1, mimeType: "text/plain" }]);
  assert.equal(rejected.status, 413);
  assert.deepEqual(await fs.readdir(root), []);
  const over = await begin(root, [{ name: "too-large.txt", size: MAX_UPLOAD_FILE_BYTES + 1, mimeType: "text/plain" }]);
  assert.equal(over.status, 413);
  assert.deepEqual(await fs.readdir(root), []);
  const upload = await begin(root, files);
  assert.equal(upload.status, 200);
  const chunk = Buffer.alloc(UPLOAD_CHUNK_BYTES, 65);
  for (let index = 0; index < files.length; index++) {
    for (let offset = 0; offset < MAX_UPLOAD_FILE_BYTES; offset += chunk.length) {
      const response = await put(upload.id, index, offset, chunk);
      assert.equal(response.status, 200, await response.text());
    }
  }
  const committed = await post({ operation: "commit", id: upload.id });
  assert.equal(committed.status, 200, await committed.clone().text());
  assert.equal((await committed.json()).uploaded.length, 10);
  for (const file of files) assert.equal((await fs.stat(path.join(root, file.name))).size, MAX_UPLOAD_FILE_BYTES);
});

test("actual payload bytes and incomplete uploads cannot bypass declared sizes; cleanup is immediate", async t => {
  const root = await workspace(t);
  const file = [{ name: "tiny.txt", size: 2, mimeType: "text/plain" }];
  let upload = await begin(root, file);
  assert.equal((await put(upload.id, 0, 0, "ABC")).status, 400);
  assert.deepEqual(await fs.readdir(root), []);
  upload = await begin(root, file);
  assert.equal((await put(upload.id, 0, 0, "AB", { "content-length": "1" })).status, 400);
  assert.deepEqual(await fs.readdir(root), []);
  upload = await begin(root, file);
  assert.equal((await post({ operation: "commit", id: upload.id })).status, 400);
  assert.deepEqual(await fs.readdir(root), []);
  upload = await begin(root, file);
  const cancelled = await handleAttachmentUpload(new Request(`http://local/api/attachments?id=${upload.id}`, { method: "DELETE" }));
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await fs.readdir(root), []);
});

test("reuses conflicts, denies traversal and symlink overwrite", async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "existing.txt"), "keep");
  await fs.symlink("existing.txt", path.join(root, "link.txt"));
  assert.equal((await begin(root, [{ name: "../escape", size: 1, mimeType: "text/plain" }])).status, 400);
  assert.equal((await begin(root, [{ name: "agent.db", size: 1, mimeType: "text/plain" }])).status, 403);
  assert.equal((await begin(root, [{ name: "existing.txt", size: 1, mimeType: "text/plain" }])).status, 409);
  const upload = await begin(root, [{ name: "link.txt", size: 1, mimeType: "text/plain" }], false, "overwrite");
  assert.equal((await put(upload.id, 0, 0, "X")).status, 200);
  const result = await post({ operation: "commit", id: upload.id });
  assert.equal(result.status, 207);
  assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "keep");
});

test("real PDF, OCR PDF, DOCX tables, XLSX rows and arbitrary source text extract to sections", async t => {
  const root = await workspace(t);
  const fixture = spawnSync("python3", ["-B", "-c", `
import fitz, os, sys
from docx import Document
from openpyxl import Workbook
root=sys.argv[1]
doc=fitz.open(); page=doc.new_page(); page.insert_text((60,90), 'searchable PDF marker', fontsize=24); doc.save(os.path.join(root,'sample.pdf'))
pix=page.get_pixmap(matrix=fitz.Matrix(2,2)); scan=fitz.open(); p=scan.new_page(); p.insert_image(p.rect, stream=pix.tobytes('png')); scan.save(os.path.join(root,'scan.pdf'))
word=Document(); word.add_paragraph('DOCX paragraph marker'); table=word.add_table(rows=1, cols=1); table.cell(0,0).text='DOCX table marker'; word.save(os.path.join(root,'sample.docx'))
book=Workbook(); book.active.title='Data'; book.active.append(['XLSX row marker', 42]); book.save(os.path.join(root,'sample.xlsx'))
`, root], { encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  await fs.writeFile(path.join(root, "Cargo.lock"), 'source marker\nsecond line');
  const { readDocumentSections } = await jiti.import("./document-text.ts");
  for (const [name, marker, location] of [["sample.pdf", "searchable PDF marker", "Page"], ["scan.pdf", "searchable PDF marker", "Page"], ["sample.docx", "DOCX table marker", "Paragraph"], ["sample.xlsx", "XLSX row marker", "Sheet Data"], ["Cargo.lock", "source marker", "Line 1"]]) {
    const sections = [];
    for await (const section of readDocumentSections(path.join(root, name))) sections.push(section);
    assert.ok(sections.some(section => section.text.includes(marker) && section.location.includes(location)), name);
  }
  await fs.writeFile(path.join(root, "bad.bin"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(() => readDocumentSections(path.join(root, "bad.bin")).next());
});

test("composer upload preserves originals and extracted paths, not inline document data", async t => {
  const root = await workspace(t);
  const content = "Document marker\nsecond line";
  const upload = await begin(root, [{ name: "notes.txt", size: Buffer.byteLength(content), mimeType: "text/plain" }], true);
  assert.equal((await put(upload.id, 0, 0, content)).status, 200);
  const result = await post({ operation: "commit", id: upload.id });
  assert.equal(result.status, 200, await result.clone().text());
  const [attachment] = (await result.json()).attachments;
  assert.equal(await fs.readFile(attachment.path, "utf8"), content);
  assert.ok((await fs.readFile(attachment.textPath, "utf8")).includes("Line 2\nsecond line"));
  assert.equal(attachment.content, undefined);
});
