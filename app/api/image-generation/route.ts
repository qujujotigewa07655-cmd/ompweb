import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getAllowedFileRoots, getConfigAgentRoots, isExistingFilePathAllowed, isUnderConfigRoot } from "@/lib/file-access";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { generateImages, imageProviderOptions, ImageGenerationError, validateImageGeneration } from "@/lib/image-generation";

export const dynamic = "force-dynamic";

async function projectDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new ImageGenerationError("The project path must be absolute.");
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(value, roots) || isUnderConfigRoot(value, getConfigAgentRoots())) throw new ImageGenerationError("The project is not accessible.", 403);
  const directory = await realpath(value);
  if (isUnderConfigRoot(directory, getConfigAgentRoots())) throw new ImageGenerationError("The project is not accessible.", 403);
  if (!(await stat(directory)).isDirectory()) throw new ImageGenerationError("Choose a project directory.");
  return directory;
}

async function imageDirectory(cwd: string, create = false): Promise<string | null> {
  const directory = path.join(cwd, ".ompweb-images");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let canonical: string;
  try { canonical = await realpath(directory); }
  catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (canonical !== directory) throw new ImageGenerationError("The image directory must not be a symbolic link.", 403);
  return directory;
}

function imageLinks(filePath: string) {
  const url = `/api/files/${encodeFilePathForApi(filePath)}`;
  return { path: filePath, url: `${url}?type=read`, downloadUrl: `${url}?type=download` };
}

async function saveFile(file: string, contents: Buffer | string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(contents); }
  catch (error) { await unlink(file).catch(() => {}); throw error; }
  finally { await handle.close(); }
}

function failure(error: unknown) {
  if (error instanceof ImageGenerationError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "The request is too large." }, { status: 413 });
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON." }, { status: 400 });
  return Response.json({ error: "Could not process the image or save it in the project." }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    const providers = await imageProviderOptions(req.signal);
    if (!cwd) return Response.json({ providers, images: [] });
    const directory = await imageDirectory(await projectDirectory(cwd));
    const images = [];
    if (directory) {
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !/^[a-f0-9-]+\.json$/.test(file.name)) continue;
        try {
          const metadataPath = path.join(directory, file.name);
          if ((await stat(metadataPath)).size > 256 * 1024) continue;
          const record = JSON.parse(await readFile(metadataPath, "utf8"));
          if (typeof record.file !== "string" || !/^[a-f0-9-]+\.(png|jpeg|webp)$/.test(record.file)) continue;
          const imagePath = path.join(directory, record.file);
          if (!isExistingFilePathAllowed(imagePath, await getAllowedFileRoots())) continue;
          images.push({ ...imageLinks(imagePath), prompt: String(record.prompt ?? ""), provider: String(record.provider ?? ""), model: String(record.model ?? ""), createdAt: String(record.createdAt ?? "") });
        } catch { /* Incomplete metadata is not an image and is never executed. */ }
      }
    }
    images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ providers, images }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(req: Request) {
  try {
    const input = validateImageGeneration(await parseJsonWithinLimit(req, 160_000));
    const cwd = await projectDirectory(input.cwd);
    const directory = await imageDirectory(cwd, true);
    if (!directory) throw new Error("Missing image directory");
    const outputs = await generateImages(input, req.signal);
    const images = [];
    for (const output of outputs) {
      req.signal.throwIfAborted();
      const data = Buffer.from(output.data, "base64");
      const info = await sharp(data, { limitInputPixels: 100_000_000 }).metadata();
      const extension = info.format === "png" ? "png" : info.format === "jpeg" ? "jpeg" : info.format === "webp" ? "webp" : null;
      if (!extension) throw new ImageGenerationError("The API returned an unsupported image format.", 502);
      const id = randomUUID();
      const file = `${id}.${extension}`;
      const filePath = path.join(directory, file);
      const metadata = { file, provider: input.provider, model: input.model, prompt: input.prompt, createdAt: new Date().toISOString() };
      await saveFile(filePath, data);
      try { await saveFile(path.join(directory, `${id}.json`), JSON.stringify(metadata)); }
      catch (error) { await unlink(filePath).catch(() => {}); throw error; }
      images.push({ ...metadata, ...imageLinks(filePath) });
    }
    return Response.json({ images });
  } catch (error) { return failure(error); }
}
