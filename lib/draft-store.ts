export interface ChatDraftImage {
  data: string;
  mimeType: string;
  /** Set when the image was uploaded to the workspace: the path replaces the inline bytes. */
  path?: string;
  /** The bounded vision derivative the agent reads. */
  visionPath?: string;
  name?: string;
  size?: number;
}

export interface ChatDraftFile {
  name: string;
  mimeType: string;
  content: string;
  size: number;
  /** Set when the file was uploaded to the workspace: the path replaces the inline content. */
  path?: string;
  /** The extracted sections of an uploaded document. */
  textPath?: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
}

/** Content to put back in a composer. `replace` merges a later recovery with
 *  an earlier one in order: while the draft still starts with `lead` (the
 *  earlier block), it becomes `text`; otherwise only `fallback` is prepended.
 *  `images` are appended to the draft's attachments. */
export interface DraftRecovery {
  text: string;
  replace?: { lead: string; fallback: string };
  images?: ChatDraftImage[];
}

/** The `{ data, mimeType }` images in an omp RPC payload; anything else is dropped. */
export function toDraftImages(value: unknown): ChatDraftImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image: unknown) => (
    image && typeof image === "object" && "data" in image && "mimeType" in image
      && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ data: image.data, mimeType: image.mimeType }]
      : []
  ));
}

export function mergeRecoveredText(current: string, { text, replace }: DraftRecovery): string {
  if (!text) return current;
  if (replace && current.startsWith(replace.lead)) return text + current.slice(replace.lead.length);
  const lead = replace ? replace.fallback : text;
  return current ? `${lead}\n\n${current}` : lead;
}

// globalThis so dev Fast Refresh doesn't wipe drafts mid-typing.
declare global {
  var __ompChatDrafts: Map<string, ChatDraft> | undefined;
  var __ompChatDraftListeners: Set<() => void> | undefined;
  var __ompChatDraftRecoveryListeners: Set<(key: string, recovery: DraftRecovery) => void> | undefined;
}

const MAX_DRAFTS = 50;
const STORAGE_PREFIX = "omp-draft-";
const drafts: Map<string, ChatDraft> = (globalThis.__ompChatDrafts ??= readStoredDrafts());

function readStoredDrafts(): Map<string, ChatDraft> {
  const stored = new Map<string, ChatDraft>();
  try {
    // Snapshot keys: removing overflow can change Storage's enumeration order.
    const storageKeys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      if (stored.size >= MAX_DRAFTS) {
        sessionStorage.removeItem(storageKey);
        continue;
      }
      const value = sessionStorage.getItem(storageKey);
      if (value) {
        // A draft written before the attachment paths existed holds only the
        // text; a newer one is a JSON object with the uploaded paths.
        const parsed: unknown = value.startsWith("{\"draftVersion\":1,") ? JSON.parse(value) : null;
        const draft = parsed as { value?: string; images?: ChatDraftImage[]; files?: ChatDraftFile[] } | null;
        stored.set(storageKey.slice(STORAGE_PREFIX.length), draft && typeof draft.value === "string"
          ? { value: draft.value, images: Array.isArray(draft.images) ? draft.images : [], files: Array.isArray(draft.files) ? draft.files : [] }
          : { value, images: [], files: [] });
      } else {
        sessionStorage.removeItem(storageKey);
      }
    }
  } catch {
    // Storage may be unavailable (SSR or browser policy); keep drafts in memory.
  }
  return stored;
}

const listeners = (globalThis.__ompChatDraftListeners ??= new Set<() => void>());
const recoveryListeners = (globalThis.__ompChatDraftRecoveryListeners ??= new Set<(key: string, recovery: DraftRecovery) => void>());

export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function recoverDraft(key: string, recovery: DraftRecovery): void {
  if (key) {
    const draft = getDraft(key) ?? { value: "", images: [], files: [] };
    setDraft(key, {
      ...draft,
      value: mergeRecoveredText(draft.value, recovery),
      images: [...draft.images, ...(recovery.images ?? [])],
    });
  }
  // Publish the recovery intent separately: ordinary persistence must not
  // reapply it, and the mounted composer may have React updates still queued.
  for (const listener of recoveryListeners) listener(key, recovery);
}

export function getDraftSummary(key: string): { text: string; hasAttachments: boolean } {
  const draft = drafts.get(key);
  if (!draft) return { text: "", hasAttachments: false };
  return {
    text: draft.value,
    hasAttachments: draft.images.length > 0 || draft.files.length > 0,
  };
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  if (drafts.size >= MAX_DRAFTS && !drafts.has(key)) {
    const oldestKey = drafts.keys().next().value;
    if (oldestKey !== undefined) clearDraft(oldestKey);
  }
  drafts.set(key, cloneDraft(draft));
  try {
    // Persist the text and the paths of uploaded attachments. The bytes of an
    // inline attachment would exhaust the tab's storage quota, so an uploaded
    // file is kept as its path and restored from the workspace.
    const files = draft.files.filter((file) => file.path).map((file) => ({ ...file, content: "" }));
    const images = draft.images.filter((image) => image.path).map((image) => ({ ...image, data: "" }));
    if (draft.value || files.length || images.length) {
      sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({ draftVersion: 1, value: draft.value, images, files }));
    } else sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Preserve the in-memory draft if storage is unavailable or full.
  }
  for (const listener of listeners) listener();
}

export function clearDraft(key: string): void {
  const deleted = drafts.delete(key);
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Storage may be unavailable.
  }
  if (deleted) {
    for (const listener of listeners) listener();
  }
}
