import { ensureSearchIndex, indexStatus, readSections, resolveSource, safePath, searchDatabase, type IndexStatus, type Section } from "./search-index";
import type { FullTextSearchPage, FullTextSearchPreviewPage, FullTextSearchResult } from "./full-text-search-types";
import { getArchivedSessionsDir, getSessionsDir } from "./omp/paths";

export { indexStatus };

const PAGE_SIZE = 50;
const PREVIEW_SIZE = 32_768;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function validateSearchQuery(query: string): string {
  const value = query.trim();
  if (!value || value.length > 256) throw new Error("Search text must contain 1–256 characters");
  return value;
}

/**
 * Build an FTS5 prefilter from non-NUL ASCII trigrams of the original needle.
 * Unicode lowercasing and UTF-16 slices do not preserve /iu equivalence, so
 * other trigrams are omitted and a needle without safe trigrams uses a scan.
 *
 * Every accepted trigram is required. Chunks repeat the previous 255 UTF-16
 * code units, so a validated needle also fits whole in the following chunk.
 */
function trigramQuery(needle: string): string | null {
  const grams: string[] = [];
  for (let index = 0; index + 3 <= needle.length; index++) {
    const gram = needle.slice(index, index + 3);
    if (gram.includes("\0") || /[^\p{ASCII}]/u.test(gram)) continue;
    const lower = gram.toLowerCase();
    if (!grams.includes(lower)) grams.push(lower);
  }
  if (!grams.length) return null;
  return grams.map((gram) => `"${gram.replace(/"/g, '""')}"`).join(" AND ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type StoredSection = { id: number; path: string; src: string; kind: FullTextSearchResult["kind"]; sec: number; loc: string; entry_id: string | null; title: string; session: string | null; file_path: string | null; overlap: number; line_base: number | null; text: Uint8Array };

/**
 * Search every indexed section once and hand matches to the caller in stored
 * order. Files are re-parsed only when their mtime or size changed, so a search
 * never walks the transcripts again.
 */
export async function searchFullText(query: string, options: { cursor?: number; signal?: AbortSignal } = {}): Promise<FullTextSearchPage> {
  const needle = validateSearchQuery(query);
  const pattern = new RegExp(escapeRegex(needle), "giu");
  const cursor = options.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid search cursor");
  options.signal?.throwIfAborted();
  const sync = await ensureSearchIndex();
  options.signal?.throwIfAborted();
  const page: FullTextSearchPage = { results: [], nextCursor: null, warnings: [...sync.warnings], warningCount: sync.warningCount };
  let matched = 0;
  // Needles without safe ASCII trigrams scan parsed text, not source files.
  const columns = "id, path, src, kind, sec, loc, entry_id, title, session, file_path, overlap, line_base, CAST(text AS BLOB) AS text";
  // detail=none answers an AND of trigrams without storing positions.
  // Oversized and NUL-containing sections stay outside FTS and use the same
  // /iu literal semantics used to verify candidates below.
  const trigrams = trigramQuery(needle);
  const scanNeedle = needle.includes("\0") ? Buffer.from(needle, "utf8") : needle;
  // Only the ids are read first: a common needle can match 58 thousand
  // sections, and loading all of their text costs seconds. The text of a
  // section is fetched when the page actually needs it.
  const ids = trigrams
    ? searchDatabase().prepare(`SELECT id FROM sections WHERE fts_ok = 0 AND icontains(CAST(text AS BLOB), ?)
        UNION ALL
        SELECT id FROM sections WHERE id IN (SELECT rowid FROM sections_fts WHERE sections_fts MATCH ?)
        ORDER BY id`).iterate(scanNeedle, trigrams)
    : searchDatabase().prepare(`SELECT id FROM sections WHERE icontains(CAST(text AS BLOB), ?) ORDER BY id`).iterate(scanNeedle);
  const load = searchDatabase().prepare(`SELECT ${columns} FROM sections WHERE id = ?`);
  for (const { id } of ids as Iterable<{ id: number }>) {
    const row = load.get(id) as StoredSection | undefined;
    if (!row) continue;
    options.signal?.throwIfAborted();
    const text = decoder.decode(row.text);
    pattern.lastIndex = 0;
    const session = row.session ? JSON.parse(row.session) as FullTextSearchResult["session"] : undefined;
    for (const match of text.matchAll(pattern)) {
      const offset = match.index;
      if (offset + match[0].length <= row.overlap) continue;
      if (matched++ < cursor) continue;
      if (page.results.length === PAGE_SIZE) { page.nextCursor = cursor + PAGE_SIZE; return page; }
      const start = Math.max(0, offset - 100);
      const end = Math.min(text.length, offset + needle.length + 180);
      page.results.push({
        kind: row.kind,
        source: row.src,
        title: session?.name || row.title,
        location: matchLocation(row, text, offset),
        snippet: text.slice(start, end),
        matchStart: offset - start,
        matchEnd: offset - start + needle.length,
        section: row.sec,
        offset,
        ...(row.entry_id ? { entryId: row.entry_id } : {}),
        ...(session ? { session } : {}),
        ...(row.file_path ? { filePath: row.file_path } : {}),
      });
    }
  }
  return page;
}

export async function readSearchPreview(sourceId: string, sectionIndex: number, offset: number, signal?: AbortSignal, entryId?: string): Promise<FullTextSearchPreviewPage> {
  if (!Number.isSafeInteger(sectionIndex) || sectionIndex < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid preview position");
  signal?.throwIfAborted();
  const source = await resolveSource(sourceId);
  await safePath(source.filePath, source.kind === "file" ? source.filePath : source.kind === "archive" ? getArchivedSessionsDir() : getSessionsDir());
  signal?.throwIfAborted();
  // No resync here: a preview always follows a search, and the index already
  // holds the section. A section the index does not know is parsed directly.
  const db = searchDatabase();
  const row = (entryId && source.kind !== "file"
    ? db.prepare("SELECT loc, CAST(text AS BLOB) AS text FROM sections WHERE path = ? AND entry_id = ? ORDER BY sec LIMIT 1").get(source.filePath, entryId)
    : db.prepare("SELECT loc, CAST(text AS BLOB) AS text FROM sections WHERE path = ? AND sec = ? LIMIT 1").get(source.filePath, sectionIndex)) as { loc: string; text: Uint8Array } | undefined;
  if (!row) return previewFromFile(source, sectionIndex, offset, signal, source.kind === "file" ? undefined : entryId);
  const text = decoder.decode(row.text);
  const start = Math.min(offset, text.length);
  return { text: text.slice(start, start + PREVIEW_SIZE), location: row.loc, offset: start, nextOffset: start + PREVIEW_SIZE < text.length ? start + PREVIEW_SIZE : null, previousOffset: start > 0 ? Math.max(0, start - PREVIEW_SIZE) : null };
}

/** Index lagged behind a very recent write: fall back to parsing the source itself. */
async function previewFromFile(source: Awaited<ReturnType<typeof resolveSource>>, sectionIndex: number, offset: number, signal?: AbortSignal, entryId?: string): Promise<FullTextSearchPreviewPage> {
  let index = 0;
  for await (const section of readSections(source, signal)) {
    const current = index++;
    if (entryId ? section.entryId !== entryId : current !== sectionIndex) continue;
    return previewPage(section, offset);
  }
  throw new Error("Matching section no longer exists; search again");
}

/**
 * A text section covers many lines, so the reported location names the line the
 * match actually starts on instead of the section's first line. A match that
 * starts inside the repeated tail of the previous section belongs to the line
 * it began on there.
 */
function matchLocation(row: StoredSection, text: string, offset: number): string {
  if (row.line_base === null) return row.loc;
  const overlap = row.overlap;
  const newline = (text: string) => {
    let count = 0;
    for (const character of text) if (character === "\n") count++;
    return count;
  };
  if (offset >= overlap) return `Line ${row.line_base + newline(text.slice(overlap, offset))}`;
  const tailEndsLine = overlap > 0 && text.charCodeAt(overlap - 1) === 10;
  const tailLines = newline(text.slice(0, overlap));
  return `Line ${row.line_base - tailLines - (tailEndsLine ? 0 : 1) + newline(text.slice(0, offset))}`;
}

function previewPage(section: Section, offset: number): FullTextSearchPreviewPage {
  const start = Math.min(offset, section.text.length);
  return { text: section.text.slice(start, start + PREVIEW_SIZE), location: section.location, offset: start, nextOffset: start + PREVIEW_SIZE < section.text.length ? start + PREVIEW_SIZE : null, previousOffset: start > 0 ? Math.max(0, start - PREVIEW_SIZE) : null };
}

export type { IndexStatus };
