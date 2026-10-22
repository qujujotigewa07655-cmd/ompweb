import { createReadStream, mkdirSync, promises as fs, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { getArchivedSessionsDir, getDiagnosticsDir, getSessionsDir } from "./omp/paths";
import { getConfigAgentRoots, isConfigRootDeniedFile, isPathWithinRoots, isUnderConfigRoot } from "./file-access";
import { listAllSessions } from "./session-reader";
import { loadProjectRegistry, mergeProjects } from "./project-registry";
import { readDocumentSections } from "./document-text";
import type { SessionInfo } from "./types";
import type { FullTextSearchResult } from "./full-text-search-types";

/**
 * Persistent extraction store for full text search.
 *
 * Searching used to re-parse every session, archive and project file on each
 * request (~1.3 GB of JSONL), which took minutes on a real history. This module
 * parses each file once, keeps its searchable sections in SQLite, and re-parses
 * a file only when its modification time or size changed.
 *
 * Searches check source sizes and modification times before reading stored
 * text. A background pass also keeps the cache fresh between searches; only
 * changed sources are parsed again.
 */

const PRIVATE_DIRECTORIES: Record<string, true> = { ".git": true, ".ssh": true, ".gnupg": true, ".aws": true, ".azure": true, ".kube": true, ".omp": true, ".agents": true, ".agent": true, ".config": true, ".dsh": true, ".claude": true, ".codex": true };
const PRIVATE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.?credentials(?:\..*)?|\.?secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const DOCUMENT_EXTENSIONS: Record<string, true> = { ".pdf": true, ".docx": true, ".xlsx": true };
/** Dependency and build output directories, matching the file browser's skip list. */
const IGNORED_NAMES: Record<string, true> = { node_modules: true, ".git": true, ".next": true, dist: true, build: true, __pycache__: true, ".turbo": true, ".cache": true, coverage: true, ".pytest_cache": true, ".mypy_cache": true, target: true, vendor: true, ".gopath": true };
/** Sections above this size stay out of the trigram index; the row scan covers them. */
const FTS_MAX_SECTION = 1_000_000;
/** Chunk size of one searchable text section, matching the extractor frame. */
const CHUNK = 16_384;
/** Characters of the previous chunk repeated in the next one, so matches across a chunk border stay findable. */
const OVERLAP = 255;
/** How long a project-file refresh may lag behind the file system. */
const PROJECT_REFRESH_MS = 30_000;
/** How long the list of managed project roots is reused. */
const ROOTS_TTL_MS = 60_000;
// 6: a text file that became binary used to keep its sections while only its
// size and time were refreshed, so an existing cache can still answer with the
// old text. Dropping the tables rebuilds the cache instead of leaving rows that
// no later pass revisits.
const SCHEMA_VERSION = 6;

export type Source = { kind: FullTextSearchResult["kind"]; source: string; filePath: string; title: string; session?: SessionInfo };
export type Section = { text: string; location: string; entryId?: string; session?: SessionInfo; overlap?: number; lineBase?: number };
export type SourceWarning = (title: string, error: unknown) => void;
export type SyncResult = { warnings: string[]; warningCount: number; /** When the project files were last walked, or null if they were never indexed. */
  projectsAt: number | null };
export type IndexStatus = { phase: "idle" | "building" | "refreshing"; done: number; indexed: number; version: number; /** When the project files were last walked. */
  projectsAt: number | null; error: string | null };

declare global {
  var __ompSearchIndex: DatabaseSync | undefined;
  var __ompSearchIndexPath: string | undefined;
  var __ompSearchIndexState: IndexStatus | undefined;
  var __ompSearchIndexPass: Promise<SyncResult> | undefined;
  /** The search-driven pass concurrent searches join; distinct from the background one. */
  var __ompSearchIndexQueued: Promise<SyncResult> | undefined;
  /** Bumped when a search-driven pass starts, so a late caller knows whether it was covered. */
  var __ompSearchIndexGeneration: number | undefined;
  var __ompSearchIndexWrite: Promise<unknown> | undefined;
  var __ompSearchIndexWarm: boolean | undefined;
  var __ompSearchIndexProjectsAt: number | undefined;
  var __ompSearchIndexTimer: ReturnType<typeof setInterval> | undefined;
  var __ompSearchIndexRoots: { roots: string[]; at: number } | undefined;
}

export function publicProjectPath(filePath: string): boolean {
  return !isUnderConfigRoot(filePath, getConfigAgentRoots())
    && !isConfigRootDeniedFile(filePath)
    && !filePath.split(path.sep).some((part) => PRIVATE_DIRECTORIES[part] === true || PRIVATE_NAMES.test(part));
}

/** The name of a file that must not be read, checked without splitting a path. */
function privateFileName(name: string): boolean {
  return PRIVATE_NAMES.test(name);
}

/** Reject symlinks in every component, including parents of the supplied root. */
export async function safePath(filePath: string, root: string): Promise<string> {
  const target = path.resolve(filePath);
  const base = path.resolve(root);
  if (!isPathWithinRoots(target, new Set([base]))) throw new Error("Search access denied");
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Search does not follow symbolic links");
  }
  const real = await fs.realpath(target);
  if (!isPathWithinRoots(real, new Set([await fs.realpath(base)]))) throw new Error("Search access denied");
  return real;
}

type WalkedFile = { filePath: string; mtimeMs: number; size: number };

/**
 * Walk a tree and report each regular file with its size and modification
 * time. The walk never follows symbolic links, so a file's path is always
 * inside the root that produced it.
 */
async function* walkFiles(root: string, options: { project: boolean; signal?: AbortSignal; onWarning?: SourceWarning }): AsyncGenerator<WalkedFile> {
  const { signal, onWarning } = options;
  signal?.throwIfAborted();
  let directory;
  try { directory = await fs.opendir(await safePath(root, root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    signal?.throwIfAborted();
    if (onWarning) { onWarning(root, error); return; }
    throw error;
  }
  try {
    for await (const entry of directory) {
      signal?.throwIfAborted();
      const filePath = path.join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.project && (IGNORED_NAMES[entry.name] === true || !publicProjectPath(filePath))) continue;
        yield* walkFiles(filePath, options);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.project && !publicProjectPath(filePath)) continue;
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) continue;
      yield { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (onWarning) onWarning(root, error);
    else throw error;
  } finally {
    await directory.close().catch(() => {});
  }
}

/**
 * Project files, read directory by directory. Every file's own size and
 * modification time is checked because directory mtimes do not track edits.
 *
 * Listings are synchronous because one promise per file made large walks much
 * slower. Opening directories uses the asynchronous API for warning handling.
 */
async function projectFiles(root: string, options: { signal?: AbortSignal; onWarning?: SourceWarning }): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  options.signal?.throwIfAborted();
  try { await safePath(root, root); }
  catch (error) { options.signal?.throwIfAborted(); options.onWarning?.(root, error); return files; }
  const stack: string[] = [root];
  while (stack.length) {
    options.signal?.throwIfAborted();
    const directory = stack.pop()!;
    // The directory is opened with the asynchronous API, because that is the
    // one the rest of the search uses to report an unreadable directory. The
    // entries are then listed synchronously: one promise per file turned a
    // two second walk into half a minute over 246 thousand files.
    try {
      const handle = await fs.opendir(directory);
      await handle.close();
    } catch (error) { options.onWarning?.(directory, error); continue; }
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { options.onWarning?.(directory, error); continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_NAMES[entry.name] === true || !publicProjectPath(filePath)) continue;
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || privateFileName(entry.name) || !publicProjectPath(filePath)) continue;
      const fileStat = statSync(filePath, { throwIfNoEntry: false });
      if (!fileStat?.isFile()) continue;
      files.push({ filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
    }
  }
  return files;
}

export async function projectRoots(): Promise<string[]> {
  const cached = globalThis.__ompSearchIndexRoots;
  if (cached && Date.now() - cached.at < ROOTS_TTL_MS) return cached.roots;
  const sessions = await listAllSessions();
  const projects = mergeProjects(loadProjectRegistry(), sessions.flatMap((s) => [s.projectRoot ?? s.cwd, s.cwd]).filter(Boolean));
  const roots: string[] = [];
  for (const project of projects) {
    if (!publicProjectPath(project.path)) continue;
    // Nested managed roots are scanned exactly once, without scanning their parents.
    if (roots.some((root) => isPathWithinRoots(project.path, new Set([root])))) continue;
    for (let i = roots.length - 1; i >= 0; i--) {
      if (isPathWithinRoots(roots[i], new Set([project.path]))) roots.splice(i, 1);
    }
    roots.push(project.path);
  }
  globalThis.__ompSearchIndexRoots = { roots, at: Date.now() };
  return roots;
}

async function readable(filePath: string): Promise<boolean> {
  if (DOCUMENT_EXTENSIONS[path.extname(filePath).toLowerCase()] === true) return true;
  const handle = await fs.open(filePath, "r");
  try {
    const sample = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return !sample.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

/** Search complete textual message payloads, omitting binary and credential fields. */
function* messageText(value: unknown, nested = false): Generator<string> {
  if (typeof value === "string") { if (!value.startsWith("blob:sha256:")) yield value; return; }
  if (typeof value === "number" || typeof value === "boolean") { yield String(value); return; }
  if (Array.isArray(value)) { for (const item of value) yield* messageText(item, true); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "image_url") return;
  for (const [name, item] of Object.entries(record)) {
    if (/^(?:type|mimeType|base64|apiKey|api_key|authorization|password|token|secret|images?)$/i.test(name)) continue;
    if (nested || ["content", "thinking", "output", "command", "code", "files", "arguments", "details", "errorMessage"].includes(name)) yield* messageText(item, true);
  }
}

/**
 * Consecutive frames of one location are searched with the previous frame's tail
 * prepended, so a match spanning the boundary is still found and can be
 * previewed. `overlap` tells the match loop to skip the duplicated prefix.
 */
async function* withOverlap(parts: AsyncGenerator<{ location: string; text: string }>): AsyncGenerator<Section> {
  let previousLocation = "";
  let tail = "";
  let character = 0;
  for await (const part of parts) {
    const overlap = part.location === previousLocation ? tail : "";
    if (!overlap) character = 0;
    yield { text: overlap + part.text, overlap: overlap.length, location: `${part.location}${character ? ` · character ${Math.max(1, character - overlap.length + 1)}` : ""}` };
    previousLocation = part.location;
    character += part.text.length;
    tail = part.text.slice(-255);
  }
}

/**
 * Plain text is chunked instead of framed per line: a line-per-section index
 * of a real history produced 25 million rows and a 21 GB database. Chunks keep
 * the row count at one per 16 KiB, and the line number of a match is derived
 * from the chunk's first line when the match is reported.
 */
async function* plainTextSections(filePath: string, signal?: AbortSignal): AsyncGenerator<Section> {
  const input = createReadStream(filePath, { signal });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let line = 1;
  let tail = "";
  const push = function* (chunk: string): Generator<Section> {
    if (!chunk.trim()) return;
    for (const character of chunk) {
      const code = character.charCodeAt(0);
      if (code < 32 && character !== "\t" && character !== "\r" && character !== "\n" && character !== "\f") throw new Error("Binary data is not a text document");
    }
    yield { text: tail + chunk, overlap: tail.length, location: `Line ${line}`, lineBase: line };
    for (const character of chunk) if (character === "\n") line++;
    tail = chunk.slice(-OVERLAP);
  };
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted();
      pending += decoder.decode(chunk as Buffer, { stream: true });
      while (pending.length >= CHUNK) {
        // Prefer a line break as the cut, so a chunk starts on a line boundary.
        let cut = pending.lastIndexOf("\n", CHUNK - 1);
        if (cut < CHUNK / 2) cut = CHUNK;
        else cut += 1;
        yield* push(pending.slice(0, cut));
        pending = pending.slice(cut);
      }
    }
    signal?.throwIfAborted();
    yield* push(pending + decoder.decode());
  } finally {
    input.destroy();
  }
}

// ponytail: memory is proportional to the largest individual JSONL entry, not
// the session file. Use a streaming JSON parser only if real entries exceed Node memory.
async function* records(source: Source, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const root = source.kind === "archive" ? getArchivedSessionsDir() : getSessionsDir();
  await safePath(source.filePath, root);
  const input = createReadStream(source.filePath, { signal });
  const gunzip = source.kind === "archive" ? createGunzip() : null;
  const stream = gunzip ?? input;
  if (gunzip) { input.on("error", (error) => gunzip.destroy(error)); input.pipe(gunzip); }
  const abort = () => { input.destroy(); stream.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const text = decoder.decode(chunk as Buffer, { stream: true });
      let start = 0;
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
        const part = text.slice(start, end);
        const line = buffered + part;
        buffered = "";
        if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
        start = end + 1;
      }
      const rest = text.slice(start);
      buffered += rest;
    }
    signal?.throwIfAborted();
    buffered += decoder.decode();
    if (buffered.trim()) yield JSON.parse(buffered) as Record<string, unknown>;
  } finally {
    signal?.removeEventListener("abort", abort);
    input.destroy(); stream.destroy();
  }
}

export async function* readSections(source: Source, signal?: AbortSignal): AsyncGenerator<Section> {
  if (source.kind === "file") {
    if (DOCUMENT_EXTENSIONS[path.extname(source.filePath).toLowerCase()] !== true) {
      yield* plainTextSections(source.filePath, signal);
      return;
    }
    yield* withOverlap(readDocumentSections(source.filePath, signal));
    return;
  }
  let session: SessionInfo | undefined;
  let title: string | undefined;
  let messageNumber = 0;
  for await (const entry of records(source, signal)) {
    if (entry.type === "title" && typeof entry.title === "string") title = entry.title;
    if (entry.type === "session" && typeof entry.id === "string") {
      const created = typeof entry.timestamp === "string" ? entry.timestamp : "";
      session = { path: source.filePath, id: entry.id, cwd: typeof entry.cwd === "string" ? entry.cwd : "", name: title ?? (typeof entry.title === "string" ? entry.title : undefined), created, modified: created, messageCount: 0, firstMessage: "" };
    }
    const message = entry.type === "message" && entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : entry.type === "custom_message"
        ? { role: "custom", content: entry.content, details: entry.details }
        : entry.type === "branch_summary" || entry.type === "compaction"
          ? { role: entry.type, content: entry.summary }
          : null;
    if (!message) continue;
    messageNumber++;
    const text = [...messageText(message)].join("\n\n");
    const entryId = typeof entry.id === "string" ? entry.id : undefined;
    yield { text, entryId, session, location: `Message ${messageNumber} · ${String(message.role ?? "message")}${entryId ? ` · ${entryId}` : ""}` };
  }
}

export async function resolveSource(id: string): Promise<Source> {
  if (id.startsWith("file:")) {
    const filePath = id.slice(5);
    const roots = await projectRoots();
    const root = roots.find((value) => isPathWithinRoots(filePath, new Set([value])));
    if (!root || !publicProjectPath(filePath)) throw new Error("Search access denied");
    return { kind: "file", source: id, filePath: await safePath(filePath, root), title: path.basename(filePath) };
  }
  const kind = id.startsWith("message:") ? "message" : id.startsWith("archive:") ? "archive" : null;
  if (!kind) throw new Error("Invalid search source");
  const key = id.slice(kind.length + 1);
  if (!key || key.includes("\\") || key.split("/").some((part) => part === ".." || part === ".") || path.isAbsolute(key)) throw new Error("Invalid search source");
  const root = kind === "message" ? getSessionsDir() : getArchivedSessionsDir();
  const filePath = await safePath(path.join(root, key), root);
  if (!filePath.endsWith(kind === "message" ? ".jsonl" : ".jsonl.gz")) throw new Error("Invalid search source");
  return { kind, source: id, filePath, title: path.basename(filePath) };
}

/** Shared read connection for search and preview queries. */
export function searchDatabase(): DatabaseSync {
  return database();
}

function database(): DatabaseSync {
  const file = path.join(getDiagnosticsDir(), "search", "index.sqlite");
  if (globalThis.__ompSearchIndex && globalThis.__ompSearchIndexPath === file) return globalThis.__ompSearchIndex;
  globalThis.__ompSearchIndex?.close();
  globalThis.__ompSearchIndex = undefined;
  globalThis.__ompSearchIndexPass = undefined;
  // A pass still walking the previous database must not be joined by a caller
  // that expects the new one.
  globalThis.__ompSearchIndexQueued = undefined;
  globalThis.__ompSearchIndexGeneration = undefined;
  globalThis.__ompSearchIndexWarm = undefined;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  // Keep the literal /iu filter inside the scan, caching its regex once per
  // needle instead of lowercasing and copying every stored section.
  let containsNeedle: string | undefined;
  let containsPattern: RegExp | undefined;
  db.function("icontains", { deterministic: true }, (text, needle) => {
    if (typeof text !== "string" || typeof needle !== "string") return 0;
    if (!containsPattern || needle !== containsNeedle) {
      containsPattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
      containsNeedle = needle;
    }
    return containsPattern.test(text) ? 1 : 0;
  });
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (version !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS sections; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sections_fts; DROP TABLE IF EXISTS meta;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      src TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS sections (
      -- AUTOINCREMENT keeps the ids growing, so the index cursor never skips
      -- a row that reuses the id of a deleted one.
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      src TEXT NOT NULL,
      kind TEXT NOT NULL,
      sec INTEGER NOT NULL,
      loc TEXT NOT NULL,
      entry_id TEXT,
      title TEXT NOT NULL,
      session TEXT,
      file_path TEXT,
      overlap INTEGER NOT NULL,
      fts_ok INTEGER NOT NULL,
      line_base INTEGER,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sections_order ON sections(path, sec);
    -- The oversized branch of a query touches only these rows; without the
    -- index SQLite scans every section to find them.
    CREATE INDEX IF NOT EXISTS sections_oversized ON sections(fts_ok) WHERE fts_ok = 0;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    -- contentless_delete=1 keeps the text only in the sections table, so the
    -- index can delete a row without rewriting its content. detail=none drops
    -- the positions, which shrinks the index twentyfold and still answers a
    -- trigram AND. The per-row delete command of an external-content index
    -- cost 30 seconds per 200 changed files.
    CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram', detail=none);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  // Older builds used a per-row delete trigger, which cost 30 seconds per
  // 200 changed files. It is dropped here so an existing index keeps its
  // content and only loses the slow trigger. A locked database means another
  // process holds the write lock; the trigger is dropped on the next start.
  try { db.exec("DROP TRIGGER IF EXISTS sections_ad;"); } catch { /* database busy */ }
  globalThis.__ompSearchIndex = db;
  globalThis.__ompSearchIndexPath = file;
  return db;
}

function state(): IndexStatus {
  globalThis.__ompSearchIndexState ??= { phase: "idle", done: 0, indexed: 0, version: 0, projectsAt: null, error: null };
  return globalThis.__ompSearchIndexState;
}

export function indexStatus(): IndexStatus {
  return { ...state() };
}

/** Run a project-file refresh now and wait for it; used by the index test. */
export async function ensureProjectRefresh(): Promise<void> {
  await fullPass();
}

/**
 * Keep the project files fresh without making a search wait for them. The
 * timer is unref'd, so it never keeps the process alive on its own.
 */
function scheduleProjectRefresh(): void {
  if (globalThis.__ompSearchIndexTimer) return;
  globalThis.__ompSearchIndexTimer = setInterval(() => {
    if (!globalThis.__ompSearchIndexWarm || globalThis.__ompSearchIndexPass) return;
    globalThis.__ompSearchIndexPass = fullPass().finally(() => { globalThis.__ompSearchIndexPass = undefined; });
    globalThis.__ompSearchIndexPass.catch(() => {});
  }, PROJECT_REFRESH_MS);
  globalThis.__ompSearchIndexTimer.unref?.();
}

type KnownFile = { mtime: number; size: number; error: string | null };

/**
 * One writer at a time. The foreground message pass and the background project
 * pass share a connection, and SQLite refuses a second transaction.
 */
async function withWriteLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = globalThis.__ompSearchIndexWrite ?? Promise.resolve();
  const next = previous.then(run, run);
  globalThis.__ompSearchIndexWrite = next.catch(() => {});
  return next;
}

/**
 * Parse the sources that changed since the last pass and drop the ones that
 * disappeared. `messages` covers the few thousand session and archive files
 * that a search must see immediately; `projects` covers the hundreds of
 * thousands of project files that are refreshed in the background.
 */
async function syncSources(options: { messages: boolean; projects: boolean; signal?: AbortSignal }): Promise<SyncResult> {
  return withWriteLock(() => writeSources(options));
}

async function writeSources(options: { messages: boolean; projects: boolean; signal?: AbortSignal }): Promise<SyncResult> {
  const db = database();
  const current = state();
  const warnings: string[] = [];
  let warningCount = 0;
  const warn: SourceWarning = (title, error) => {
    warningCount++;
    if (warnings.length < 20) warnings.push(`${title}: ${error instanceof Error ? error.message : "Search failed"}`);
  };
  // Only the rows of the kinds this pass refreshes are loaded: the project
  // files are tens of thousands of rows a message pass never looks at.
  const known = new Map<string, KnownFile>();
  const kinds = options.projects ? ["message", "archive", "file"] : ["message", "archive"];
  const readKnown = db.prepare(`SELECT path, mtime_ms, size, error FROM files WHERE kind IN (${kinds.map(() => "?").join(",")})`);
  for (const row of readKnown.all(...kinds) as Array<{ path: string; mtime_ms: number; size: number; error: string | null }>) {
    known.set(row.path, { mtime: row.mtime_ms, size: row.size, error: row.error });
  }
  const removeFile = db.prepare("DELETE FROM files WHERE path = ?");
  const removeSections = db.prepare("DELETE FROM sections WHERE path = ?");
  const insertFile = db.prepare("INSERT OR REPLACE INTO files (path, src, kind, mtime_ms, size, error) VALUES (?, ?, ?, ?, ?, ?)");
  const insertSection = db.prepare("INSERT INTO sections (path, src, kind, sec, loc, entry_id, title, session, file_path, overlap, fts_ok, line_base, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // Trigram insertion one row at a time is far slower than a bulk select, so
  // rows are appended to the FTS table in batches after each commit instead.
  const indexPending = db.prepare("INSERT INTO sections_fts(rowid, text) SELECT id, text FROM sections WHERE fts_ok = 1 AND id > ? ORDER BY id");
  const removeIndex = db.prepare("DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE path = ? AND fts_ok = 1)");
  const removeSource = (filePath: string) => {
    // FTS rowids must be removed while the corresponding sections still exist.
    removeIndex.run(filePath);
    removeSections.run(filePath);
    removeFile.run(filePath);
  };
  const readCursor = db.prepare("SELECT value FROM meta WHERE key = 'fts_cursor'");
  const writeCursor = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_cursor', ?)");
  const advanceIndex = () => {
    const cursor = Number((readCursor.get() as { value?: number } | undefined)?.value ?? 0);
    indexPending.run(cursor);
    // Section ids only ever grow, so the highest indexed id is the resume
    // point; an interrupted pass continues from there instead of skipping rows.
    const next = Number((db.prepare("SELECT max(id) AS id FROM sections WHERE fts_ok = 1").get() as { id: number | null } | undefined)?.id ?? cursor);
    writeCursor.run(next);
  };

  const present = new Set<string>();
  let pending = 0;
  let done = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const handle = async (kind: FullTextSearchResult["kind"], source: string, filePath: string, title: string, mtimeMs: number, size: number) => {
      current.done = ++done;
      const prior = known.get(filePath);
      if (prior && prior.mtime === mtimeMs && prior.size === size) {
        if (prior.error) warn(title, new Error(prior.error));
        return;
      }
      removeSource(filePath);
      let section = 0;
      try {
        for await (const part of readSections({ kind, source, filePath, title })) {
          insertSection.run(
            filePath, source, kind, section++, part.location, part.entryId ?? null,
            part.session?.name || title, part.session ? JSON.stringify(part.session) : null,
            kind === "file" ? filePath : null, part.overlap ?? 0,
            part.text.length <= FTS_MAX_SECTION ? 1 : 0, part.lineBase ?? null, part.text,
          );
        }
      } catch (error) {
        // Keep the failure on record so the next pass does not retry a file
        // that cannot be parsed, and report it as a partial-coverage warning.
        removeSource(filePath);
        insertFile.run(filePath, source, kind, mtimeMs, size, error instanceof Error ? error.message : "Search failed");
        warn(title, error);
        return;
      }
      insertFile.run(filePath, source, kind, mtimeMs, size, null);
      if (++pending >= 200) { db.exec("COMMIT"); advanceIndex(); db.exec("BEGIN IMMEDIATE"); pending = 0; }
    };

    if (options.messages) {
      for (const [kind, root, extension] of [
        ["message", getSessionsDir(), ".jsonl"], ["archive", getArchivedSessionsDir(), ".jsonl.gz"],
      ] as const) {
        for await (const file of walkFiles(root, { project: false, signal: options.signal, onWarning: warn })) {
          options.signal?.throwIfAborted();
          if (!file.filePath.endsWith(extension)) continue;
          present.add(file.filePath);
          const relative = path.relative(root, file.filePath).split(path.sep).join("/");
          await handle(kind, `${kind}:${relative}`, file.filePath, path.basename(file.filePath), file.mtimeMs, file.size);
        }
      }
    }
    if (options.projects) {
      for (const root of await projectRoots()) {
        for (const file of await projectFiles(root, { signal: options.signal, onWarning: warn })) {
          options.signal?.throwIfAborted();
          present.add(file.filePath);
          try {
            // Unchanged files keep their parsed content and readability result.
            const prior = known.get(file.filePath);
            if (prior && prior.mtime === file.mtimeMs && prior.size === file.size) {
              // The file is unchanged, so its content — and whether it is
              // readable text — is already known.
              if (prior.error) warn(path.relative(root, file.filePath), new Error(prior.error));
              continue;
            }
            if (!(await readable(file.filePath))) {
              // Keep the binary classification until the file changes again.
              removeSource(file.filePath);
              insertFile.run(file.filePath, `file:${file.filePath}`, "file", file.mtimeMs, file.size, null);
              continue;
            }
            await handle("file", `file:${file.filePath}`, file.filePath, path.relative(root, file.filePath), file.mtimeMs, file.size);
          } catch (error) {
            options.signal?.throwIfAborted();
            warn(path.relative(root, file.filePath), error);
          }
        }
      }
    }
    // Both walks visit every eligible file, so absent sources are removed.
    if (options.projects) {
      for (const filePath of known.keys()) {
        if (present.has(filePath)) continue;
        removeSource(filePath);
      }
    }
    db.exec("COMMIT");
    advanceIndex();
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
    throw error;
  }
  current.indexed = Number((db.prepare("SELECT count(*) AS n FROM files").get() as { n?: number } | undefined)?.n ?? 0);
  return { warnings, warningCount, projectsAt: globalThis.__ompSearchIndexProjectsAt ?? null };
}

async function fullPass(): Promise<SyncResult> {
  const current = state();
  current.phase = globalThis.__ompSearchIndexWarm ? "refreshing" : "building";
  current.done = 0;
  current.error = null;
  try {
    const result = await syncSources({ messages: true, projects: true });
    globalThis.__ompSearchIndexWarm = true;
    globalThis.__ompSearchIndexProjectsAt = Date.now();
    current.projectsAt = globalThis.__ompSearchIndexProjectsAt;
    current.version++;
    scheduleProjectRefresh();
    return result;
  } catch (error) {
    current.error = error instanceof Error ? error.message : "Search index failed";
    throw error;
  } finally {
    current.phase = "idle";
  }
}

/**
 * Bring the index up to date for a search.
 *
 * Every source is checked so a file written a moment ago is found by the next
 * search. Unchanged files reuse their stored sections.
 *
 * Concurrent searches share one walk instead of each starting their own. A
 * caller can only join a pass that *started after it arrived* — an older pass
 * may already have statted its file before the write. So a burst arriving
 * during a pass waits for it and then shares one follow-up pass, rather than
 * queueing one walk per search.
 */
export async function ensureSearchIndex(): Promise<SyncResult> {
  const arrivedAt = globalThis.__ompSearchIndexGeneration ?? 0;
  for (;;) {
    const running = globalThis.__ompSearchIndexQueued;
    if (running) {
      // This pass began after we arrived, so its walk saw our changes.
      if ((globalThis.__ompSearchIndexGeneration ?? 0) > arrivedAt) return running;
      await running.catch(() => {});
      continue;
    }
    globalThis.__ompSearchIndexGeneration = (globalThis.__ompSearchIndexGeneration ?? 0) + 1;
    const pass = fullPass();
    globalThis.__ompSearchIndexQueued = pass;
    const settle = () => {
      if (globalThis.__ompSearchIndexQueued === pass) globalThis.__ompSearchIndexQueued = undefined;
    };
    pass.then(settle, settle);
    return pass;
  }
}
