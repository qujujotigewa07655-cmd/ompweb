import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The production caller passes the archive as an fd plus a display name, so
// every case drives the real script through its command line contract.
const script = path.join(import.meta.dirname, "..", "scripts", "document-text.py");

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-archive-text-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPython(code) {
  const result = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function extract(file, display) {
  const result = spawnSync("python3", ["-B", script, file, display], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stderr: result.stderr,
    sections: result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function locations(sections) {
  return sections.map((section) => section.location);
}

function text(sections) {
  return sections.map((section) => section.text).join("\n");
}

test("emits UTF-8 text members from a zip", (t) => {
  const dir = workspace(t);
  const file = path.join(dir, "payload");
  runPython(`
import zipfile
with zipfile.ZipFile(${JSON.stringify(file)}, "w") as archive:
    archive.writestr("docs/readme.txt", "привет\\nsecond line\\n")
`);
  const { status, stderr, sections } = extract(file, "bundle.zip");
  assert.equal(status, 0, stderr);
  assert.deepEqual(locations(sections), ["docs/readme.txt · Line 1", "docs/readme.txt · Line 2"]);
  assert.equal(text(sections), "привет\nsecond line");
});

test("parses a document stored inside a zip and prefixes its sections", (t) => {
  const dir = workspace(t);
  const file = path.join(dir, "payload");
  runPython(`
import zipfile
import fitz
document = fitz.open()
page = document.new_page()
page.insert_text((60, 90), "NESTED DOCUMENT MARKER", fontsize=20)
payload = document.tobytes()
document.close()
with zipfile.ZipFile(${JSON.stringify(file)}, "w") as archive:
    archive.writestr("docs/report.pdf", payload)
`);
  const { status, stderr, sections } = extract(file, "bundle.zip");
  assert.equal(status, 0, stderr);
  assert.ok(locations(sections).some((location) => location === "docs/report.pdf · Page 1"), locations(sections).join(", "));
  assert.match(text(sections), /NESTED DOCUMENT MARKER/);
});

test("emits text from .tar.gz, gzip FNAME and a nameless gzip stream", (t) => {
  const dir = workspace(t);
  const tarball = path.join(dir, "bundle.tgz");
  const named = path.join(dir, "named");
  const nameless = path.join(dir, "nameless");
  runPython(`
import gzip, io, tarfile
data = "alpha\\nbeta\\n".encode()
with tarfile.open(${JSON.stringify(tarball)}, "w:gz") as archive:
    info = tarfile.TarInfo("logs/app.log")
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))
with open(${JSON.stringify(named)}, "wb") as raw:
    with gzip.GzipFile(filename="notes.txt", mode="wb", fileobj=raw, mtime=0) as compressed:
        compressed.write("one\\ntwo\\n".encode())
with open(${JSON.stringify(nameless)}, "wb") as raw:
    raw.write(gzip.compress(b"plain\\n", mtime=0))
`);

  const tarballResult = extract(tarball, "bundle.tgz");
  assert.equal(tarballResult.status, 0, tarballResult.stderr);
  assert.deepEqual(locations(tarballResult.sections), ["logs/app.log · Line 1", "logs/app.log · Line 2"]);
  assert.equal(text(tarballResult.sections), "alpha\nbeta");

  const namedResult = extract(named, "notes.txt.gz");
  assert.equal(namedResult.status, 0, namedResult.stderr);
  assert.deepEqual(locations(namedResult.sections), ["notes.txt · Line 1", "notes.txt · Line 2"]);
  assert.equal(text(namedResult.sections), "one\ntwo");

  const namelessResult = extract(nameless, "fallback.txt.gz");
  assert.equal(namelessResult.status, 0, namelessResult.stderr);
  assert.deepEqual(locations(namelessResult.sections), ["fallback.txt · Line 1"]);
  assert.equal(text(namelessResult.sections), "plain");
});

test("a zip of binary members emits nothing and exits cleanly", (t) => {
  const dir = workspace(t);
  const file = path.join(dir, "payload");
  runPython(`
import zipfile
with zipfile.ZipFile(${JSON.stringify(file)}, "w") as archive:
    archive.writestr("nul.bin", b"\\x00" * 64)
    archive.writestr("high.bin", b"\\xa9" * 64)
`);
  const { status, stderr, sections } = extract(file, "blob.zip");
  assert.equal(status, 0, stderr);
  assert.deepEqual(sections, []);
  assert.doesNotMatch(stderr, /Traceback/);
});

test("a zip member that traverses upwards is never extracted", (t) => {
  const base = workspace(t);
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  const file = path.join(work, "payload");
  runPython(`
import zipfile
with zipfile.ZipFile(${JSON.stringify(file)}, "w") as archive:
    archive.writestr("kn/escape.txt", "escaped\\n")
    archive.writestr("kept.txt", "kept\\n")
source = ${JSON.stringify(file)}
data = open(source, "rb").read().replace(b"kn/escape.txt", b"../escape.txt")
open(source, "wb").write(data)
`);
  const { status, stderr, sections } = extract(file, "bundle.zip");
  assert.equal(status, 0, stderr);
  assert.deepEqual(locations(sections), ["kept.txt · Line 1"]);
  assert.equal(fs.existsSync(path.join(base, "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(work, "escape.txt")), false);
});

test("a declared-size bomb is refused before decompression", (t) => {
  const dir = workspace(t);
  const file = path.join(dir, "payload");
  runPython(`
import struct
name = b"bomb.txt"
size = 600 * 1024 * 1024
local = struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, 0, 0, 0, 0, 0, size, size, len(name), 0) + name + b"x"
central = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0, 0, 0, 0, 0, size, size, len(name), 0, 0, 0, 0, 0, 0) + name
end = struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, 1, 1, len(central), len(local), 0)
with open(${JSON.stringify(file)}, "wb") as target:
    target.write(local + central + end)
`);
  const { status, stderr, sections } = extract(file, "bomb.zip");
  assert.equal(status, 1);
  assert.deepEqual(sections, []);
  assert.match(stderr, /512 MiB/);
});

const sevenzip = ["7z", "7za"].find((name) => !spawnSync(name, ["i"], { encoding: "utf8" }).error);

test("emits text members from a .7z archive", { skip: sevenzip ? false : "7z is not installed" }, (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "member.txt"), "seven\nzip\n");
  const file = path.join(dir, "payload.7z");
  const created = spawnSync(sevenzip, ["a", "-bso0", "-bsp0", file, "member.txt"], { cwd: dir, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const { status, stderr, sections } = extract(file, "payload.7z");
  assert.equal(status, 0, stderr);
  assert.deepEqual(locations(sections), ["member.txt · Line 1", "member.txt · Line 2"]);
  assert.equal(text(sections), "seven\nzip");
});
