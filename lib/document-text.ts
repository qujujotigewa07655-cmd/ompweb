import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isConfigRootDeniedFile } from "./file-access";
import { createChildProcessEnvironment } from "./project-command-env";

export interface DocumentSection { location: string; text: string }

/** Stream bounded sections; closing the iterator also kills OCR descendants. */
export async function* readDocumentSections(filePath: string, signal?: AbortSignal): AsyncGenerator<DocumentSection> {
  signal?.throwIfAborted();
  const roots = await getAllowedFileRoots();
  const real = await fs.realpath(filePath);
  if (!isExistingFilePathAllowed(real, roots) || isConfigRootDeniedFile(real)) throw new Error("Document access denied");
  const source = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let temporary: string | undefined;
  try {
    if (!(await source.stat()).isFile()) throw new Error("Not a document file");
    const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${source.fd}` : real;
    const opened = await fs.realpath(descriptorPath);
    if (!isExistingFilePathAllowed(opened, roots) || isConfigRootDeniedFile(opened)) throw new Error("Document access denied");
    signal?.throwIfAborted();
    if (path.extname(real).toLowerCase() === ".pdf") temporary = await fs.mkdtemp(path.join(process.cwd(), ".omp-document-"));
    signal?.throwIfAborted();
    const child = spawn("python3", ["-B", path.join(process.cwd(), "scripts/document-text.py"), process.platform === "linux" ? "/proc/self/fd/3" : real, real], {
      stdio: ["ignore", "pipe", "pipe", source.fd], detached: process.platform !== "win32",
      env: createChildProcessEnvironment({ PYTHONDONTWRITEBYTECODE: "1", TMPDIR: temporary ?? process.cwd(), TEMP: temporary ?? process.cwd(), TMP: temporary ?? process.cwd() }),
    });
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8192); });
    const { promise: exited, resolve, reject } = Promise.withResolvers<number | null>();
    child.once("error", reject);
    child.once("close", resolve);
    void exited.catch(() => {});
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return;
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      let pending = "";
      for await (const chunk of child.stdout!) {
        signal?.throwIfAborted();
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          yield JSON.parse(line) as DocumentSection;
        }
      }
      signal?.throwIfAborted();
      if (await exited !== 0) throw new Error(stderr.trim() || "Document extraction failed");
      if (pending) throw new Error("Incomplete document extraction frame");
    } finally {
      stop();
      await exited.catch(() => {});
      signal?.removeEventListener("abort", stop);
    }
  } finally {
    await source.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}
