export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

export function validateUploadBatch(files: readonly { size: number }[], usedSlots = 0): string | null {
  if (!files.length) return "No files selected";
  if (files.length + usedSlots > MAX_UPLOAD_FILES) return "Select at most 10 files total (images and documents combined). No files in this batch were accepted.";
  if (files.some(({ size }) => !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_FILE_BYTES)) return "Each original file must be 50 MiB or smaller. No files in this batch were accepted.";
  return null;
}

export interface UploadedAttachment {
  name: string;
  mimeType: string;
  size: number;
  path: string;
  textPath?: string;
  image?: { data: string; mimeType: string };
  visionPath?: string;
}
