import { UPLOAD_CHUNK_BYTES, validateUploadBatch, type UploadedAttachment } from "./file-upload-limits";

export interface ChunkUploadResult {
  uploaded?: string[];
  skipped?: string[];
  errors?: Array<{ name: string; error: string }>;
  conflicts?: string[];
  nonReplaceable?: string[];
  attachments?: UploadedAttachment[];
  error?: string;
}

export async function uploadFileBatch(files: File[], options: {
  directory: string;
  attachments?: boolean;
  strategy?: "error" | "overwrite" | "skip";
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<{ status: number; data: ChunkUploadResult }> {
  const invalid = validateUploadBatch(files);
  if (invalid) throw new Error(invalid);
  const endpoint = "/api/attachments";
  let id: string | undefined;
  let committed = false;
  const json = async (body: unknown) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: options.signal });
    return { status: response.status, data: await response.json() as ChunkUploadResult & { id?: string } };
  };
  try {
    const initialized = await json({ operation: "begin", directory: options.directory, attachments: options.attachments === true, strategy: options.strategy ?? "error", files: files.map(file => ({ name: file.name, size: file.size, mimeType: file.type })) });
    if (initialized.status !== 200 || !initialized.data.id) return initialized;
    id = initialized.data.id;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    for (const [index, file] of files.entries()) {
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
        const chunk = file.slice(offset, offset + UPLOAD_CHUNK_BYTES);
        const response = await fetch(`${endpoint}?id=${encodeURIComponent(id)}&index=${index}&offset=${offset}`, { method: "PUT", body: chunk, signal: options.signal });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Upload failed");
        sent += chunk.size;
        options.onProgress?.(total ? Math.round(sent / total * 100) : 100);
      }
    }
    const result = await json({ operation: "commit", id });
    committed = result.status === 200;
    return result;
  } finally {
    if (id && !committed) await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }
}
