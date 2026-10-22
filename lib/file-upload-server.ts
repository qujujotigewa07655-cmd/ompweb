import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isConfigRootDeniedFile } from "./file-access";
import { inspectUploadTargets, parseUploadConflictStrategy, validateUploadFileNames, type UploadConflictStrategy } from "./file-upload";
import { parseJsonWithinLimit } from "./bounded-form-data";
import { MAX_UPLOAD_FILE_BYTES, UPLOAD_CHUNK_BYTES, validateUploadBatch, type UploadedAttachment } from "./file-upload-limits";
import { readDocumentSections } from "./document-text";
import { getImageMime } from "./file-types";

interface ManifestFile { name: string; size: number; mimeType: string; received: number }
interface Upload { directory: string; staging: string; files: ManifestFile[]; attachments: boolean; strategy: UploadConflictStrategy; busy: boolean; timer: NodeJS.Timeout; controller: AbortController }
const uploads = new Map<string, Upload>();

async function authorizeUploadDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("Upload directory must be absolute");
  const roots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directory, roots) || !isExistingFilePathAllowed(directory, roots)) throw new Error("Upload access denied");
  const real = await fs.realpath(directory);
  if (!(await fs.stat(real)).isDirectory() || isConfigRootDeniedFile(real)) throw new Error("Invalid upload directory");
  return real;
}

async function discard(id: string) {
  const upload = uploads.get(id);
  if (!upload) return;
  clearTimeout(upload.timer);
  upload.controller.abort();
  uploads.delete(id);
  await fs.rm(upload.staging, { recursive: true, force: true });
}

async function imageDerivative(original: string, output: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn("python3", ["-B", path.join(process.cwd(), "scripts/document-text.py"), "--image", original, output], { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  let error = "";
  child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-4096); });
  const stop = () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* exited */ } };
  signal.addEventListener("abort", stop, { once: true });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolve() : reject(new Error(error || "Image conversion failed")));
  try { await promise; signal.throwIfAborted(); } finally { signal.removeEventListener("abort", stop); }
}

/** Small manifest + bounded raw chunks; originals never enter a JSON/base64 body. */
export async function handleAttachmentUpload(request: Request, presetDirectory?: string): Promise<Response> {
  let activeId: string | undefined;
  let locked: Upload | undefined;
  try {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await parseJsonWithinLimit<Record<string, unknown>>(request, 64 * 1024) : {};
    if (body.operation === "begin") {
      const directory = await authorizeUploadDirectory(presetDirectory ?? String(body.directory ?? ""));
      if (!Array.isArray(body.files) || !body.files.every(file => file && typeof file === "object" && typeof file.name === "string" && typeof file.size === "number" && typeof file.mimeType === "string")) return NextResponse.json({ error: "Invalid file manifest" }, { status: 400 });
      const files = body.files as ManifestFile[];
      const invalid = validateUploadBatch(files);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 413 });
      const invalidNames = validateUploadFileNames(files.map(file => file.name));
      if (invalidNames) return NextResponse.json({ error: invalidNames }, { status: 400 });
      if (files.some(file => isConfigRootDeniedFile(file.name))) return NextResponse.json({ error: "Protected file name" }, { status: 403 });
      const strategy = parseUploadConflictStrategy(typeof body.strategy === "string" ? body.strategy : null);
      if (!strategy) return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
      const attachments = body.attachments === true;
      const inspection = inspectUploadTargets(directory, files.map(file => file.name));
      if (!attachments && strategy === "error" && inspection.conflicts.length) return NextResponse.json({ error: "One or more files already exist", ...inspection }, { status: 409 });
      const id = randomUUID();
      const staging = await fs.mkdtemp(path.join(directory, ".omp-upload-"));
      await fs.chmod(staging, 0o700);
      try {
        for (const [index, file] of files.entries()) {
          await fs.mkdir(path.join(staging, String(index)), { mode: 0o700 });
          await fs.writeFile(path.join(staging, String(index), file.name), "", { flag: "wx", mode: 0o600 });
        }
      } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
      const timer = setTimeout(() => { void discard(id); }, 30 * 60 * 1000);
      timer.unref();
      uploads.set(id, { directory, staging, files: files.map(file => ({ ...file, received: 0 })), strategy, attachments, busy: false, timer, controller: new AbortController() });
      activeId = id;
      request.signal.throwIfAborted();
      return NextResponse.json({ id, chunkBytes: UPLOAD_CHUNK_BYTES });
    }
    const id = typeof body.id === "string" ? body.id : url.searchParams.get("id") ?? "";
    const upload = uploads.get(id);
    if (!upload) return NextResponse.json({ error: "Upload expired or not found" }, { status: 404 });
    await authorizeUploadDirectory(upload.directory);
    if (presetDirectory && await authorizeUploadDirectory(presetDirectory) !== upload.directory) return NextResponse.json({ error: "Upload directory mismatch" }, { status: 403 });
    if (request.method === "DELETE") { await discard(id); return NextResponse.json({ cancelled: true }); }
    const signal = AbortSignal.any([request.signal, upload.controller.signal]);
    if (upload.busy) return NextResponse.json({ error: "Upload already in progress" }, { status: 409 });
    upload.busy = true;
    locked = upload;
    activeId = id;
    signal.throwIfAborted();
    if (request.method === "PUT") {
      const index = Number(url.searchParams.get("index"));
      const offset = Number(url.searchParams.get("offset"));
      const file = upload.files[index];
      if (!Number.isInteger(index) || !file || !Number.isSafeInteger(offset) || offset !== file.received) throw new Error("Invalid chunk index or offset");
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing upload chunk");
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancelRead, { once: true });
      const target = path.join(upload.staging, String(index), file.name);
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let chunkBytes = 0;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size !== file.received) throw new Error("Upload staging byte count mismatch");
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          chunkBytes += value.byteLength;
          if (chunkBytes > UPLOAD_CHUNK_BYTES || file.received + value.byteLength > file.size || file.received + value.byteLength > MAX_UPLOAD_FILE_BYTES) throw new Error("Upload actual bytes exceed declared size or chunk limit");
          await handle.writeFile(value);
          file.received += value.byteLength;
        }
        signal.throwIfAborted();
        const declared = request.headers.get("content-length");
        if (!chunkBytes || (declared !== null && Number(declared) !== chunkBytes)) throw new Error("Upload chunk byte count mismatch");
      } finally { signal.removeEventListener("abort", cancelRead); await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close(); }
      return NextResponse.json({ received: file.received });
    }
    if (body.operation !== "commit") throw new Error("Invalid upload operation");
    for (const [index, file] of upload.files.entries()) {
      const stat = await fs.lstat(path.join(upload.staging, String(index), file.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || file.received !== file.size) throw new Error("Upload actual bytes do not match declared size");
    }
    const attachments: UploadedAttachment[] = [];
    if (upload.attachments) {
      await fs.mkdir(path.join(upload.staging, "derived"), { mode: 0o700 });
      for (const [index, file] of upload.files.entries()) {
        signal.throwIfAborted();
        const original = path.join(upload.staging, String(index), file.name);
        const attachment: UploadedAttachment = { name: file.name, size: file.size, mimeType: file.mimeType, path: original };
        const derived = path.join(upload.staging, "derived", String(index));
        await fs.mkdir(derived, { mode: 0o700 });
        const imageMime = getImageMime(file.name) ?? (file.mimeType.startsWith("image/") ? file.mimeType : null);
        if (imageMime) {
          attachment.mimeType = imageMime;
          const derivative = path.join(derived, "vision.jpg");
          attachment.visionPath = derivative;
          await imageDerivative(original, derivative, signal);
          attachment.image = { data: (await fs.readFile(derivative)).toString("base64"), mimeType: "image/jpeg" };
        } else {
          const extracted = path.join(derived, "extracted-sections.txt");
          const handle = await fs.open(extracted, "wx", 0o600);
          try { for await (const section of readDocumentSections(original, signal)) await handle.writeFile(`${section.location}\n${section.text}\n\n`); } finally { await handle.close(); }
          attachment.textPath = extracted;
        }
        attachments.push(attachment);
      }
      // Finalize the private directory only after every original parsed successfully.
      signal.throwIfAborted();
      const final = path.join(upload.directory, `.omp-attachments-${id}`);
      await fs.rename(upload.staging, final);
      for (const attachment of attachments) {
        attachment.path = path.join(final, path.relative(upload.staging, attachment.path));
        if (attachment.textPath) attachment.textPath = path.join(final, path.relative(upload.staging, attachment.textPath));
        if (attachment.visionPath) attachment.visionPath = path.join(final, path.relative(upload.staging, attachment.visionPath));
      }
      clearTimeout(upload.timer);
      uploads.delete(id);
      return NextResponse.json({ attachments, uploaded: upload.files.map(file => file.name) });
    }
    const inspection = inspectUploadTargets(upload.directory, upload.files.map(file => file.name));
    if (upload.strategy === "error" && inspection.conflicts.length) { await discard(id); return NextResponse.json({ error: "One or more files already exist", ...inspection }, { status: 409 }); }
    const uploaded: string[] = [], skipped: string[] = [], errors: Array<{ name: string; error: string }> = [];
    for (const [index, file] of upload.files.entries()) {
      signal.throwIfAborted();
      if (inspection.conflicts.includes(file.name) && upload.strategy === "skip") { skipped.push(file.name); continue; }
      if (inspection.nonReplaceable.includes(file.name)) { errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" }); continue; }
      const source = path.join(upload.staging, String(index), file.name);
      const destination = path.join(upload.directory, file.name);
      try {
        // Staging is on the same volume: exclusive links avoid copying originals;
        // replacement rename is atomic and never follows a destination symlink.
        if (upload.strategy === "overwrite" && inspection.conflicts.includes(file.name)) {
          const current = await fs.lstat(destination);
          if (!current.isFile() || current.isSymbolicLink()) throw new Error("Cannot replace a directory or symbolic link");
          await fs.rename(source, destination);
        } else {
          await fs.link(source, destination);
        }
        uploaded.push(file.name);
      } catch (error) { errors.push({ name: file.name, error: String(error) }); }
    }
    await discard(id);
    return NextResponse.json({ uploaded, skipped, errors }, { status: errors.length ? 207 : 200 });
  } catch (error) {
    if (activeId) await discard(activeId);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally { if (locked) locked.busy = false; }
}
