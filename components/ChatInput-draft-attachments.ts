import type { ChatDraftFile, ChatDraftImage } from "@/lib/draft-store";
import {
  selectTextAttachments,
  type AttachedTextFileData,
} from "@/lib/chat-attachments";
import { getBase64DecodedByteLength, isBase64ImageWithinLimits, MAX_ATTACHED_IMAGE_BYTES, MAX_TOTAL_ATTACHED_IMAGE_BYTES } from "@/lib/image-attachments";
import { encodeFilePathForApi } from "@/lib/file-paths";

export interface AttachedImage extends ChatDraftImage {
  previewUrl: string;
}

export type AttachedTextFile = AttachedTextFileData;

export function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return {
    data: image.path ? "" : image.data,
    mimeType: image.mimeType,
    ...(image.path ? { path: image.path, visionPath: image.visionPath, name: image.name, size: image.size } : {}),
  };
}

export function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: image.visionPath
      ? `/api/files/${encodeFilePathForApi(image.visionPath)}?type=read`
      : `data:${image.mimeType};base64,${image.data}`,
  };
}

/** Every image comes back, even past MAX_ATTACHED_IMAGES (recovered queue
 *  messages can exceed it); sending enforces the cap, so the user chooses. */
export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter((image) => (typeof image?.path === "string" && !!image.path && typeof image.visionPath === "string" && !!image.visionPath
        && image.data === "" && typeof image.mimeType === "string" && image.mimeType.startsWith("image/"))
      || isBase64ImageWithinLimits(image))
    .map(draftImageToAttachedImage);
}

export function textFileToDraftFile(file: AttachedTextFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, content: file.content, size: file.size, path: file.path, textPath: file.textPath };
}

export function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedTextFile[] {
  const shaped = (files ?? []).filter((file) => typeof file.name === "string"
    && typeof file.mimeType === "string"
    && typeof file.content === "string"
    && Number.isFinite(file.size));
  // An uploaded file is referenced by path, so its original size must not
  // consume the inline budget — otherwise a large document silently evicts the
  // inline text restored beside it.
  const uploaded: AttachedTextFile[] = [];
  const candidates: AttachedTextFile[] = [];
  for (const file of shaped) (typeof file.path === "string" ? uploaded : candidates).push(file);
  const inline = selectTextAttachments(candidates, { usedBytes: 0, usedSlots: uploaded.length }).accepted;
  return [...inline, ...uploaded];
}

export function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

export function readImageData(blob: Blob, signal: AbortSignal, failed: string): Promise<string> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  const abort = () => { reader.abort?.(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  reader.onload = () => { cleanup(); resolve(String(reader.result).split(",")[1]); };
  reader.onerror = () => { cleanup(); reject(new Error(failed)); };
  reader.onabort = () => { cleanup(); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  reader.readAsDataURL(blob);
  return promise;
}

/** Only bounded vision derivatives enter the RPC payload; originals remain on disk.
 *  `errors` carries the localized text the composer shows, so this module never
 *  owns user-facing copy. */
export async function hydrateAttachedImages(images: AttachedImage[], signal: AbortSignal, errors: { readFailed: string; tooLarge: string }): Promise<AttachedImage[]> {
  let remaining = MAX_TOTAL_ATTACHED_IMAGE_BYTES
    - images.reduce((sum, image) => sum + (getBase64DecodedByteLength(image.data) ?? 0), 0);
  const hydrated: AttachedImage[] = [];
  for (const image of images) {
    signal.throwIfAborted();
    if (image.data || !image.visionPath) { hydrated.push(image); continue; }
    const response = await fetch(`/api/files/${encodeFilePathForApi(image.visionPath)}?type=read`, { signal });
    if (!response.ok) throw new Error(errors.readFailed);
    const limit = Math.min(remaining, MAX_ATTACHED_IMAGE_BYTES);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!mimeType.startsWith("image/") || Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error(errors.tooLarge);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(errors.readFailed);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: BlobPart[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error(errors.tooLarge);
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = await readImageData(new Blob(chunks, { type: mimeType }), signal, errors.readFailed);
    remaining -= bytes;
    hydrated.push({ ...image, data, mimeType });
  }
  return hydrated;
}
