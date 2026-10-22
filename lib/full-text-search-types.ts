import type { SessionInfo } from "./types";

export interface FullTextSearchResult {
  kind: "message" | "archive" | "file";
  source: string;
  title: string;
  location: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  /** Stable section and offset used by the read-only preview. */
  section: number;
  offset: number;
  entryId?: string;
  session?: SessionInfo;
  filePath?: string;
}
export interface FullTextSearchPage {
  results: FullTextSearchResult[];
  nextCursor: number | null;
  warnings: string[];
  warningCount: number;
}
export interface FullTextSearchIndexStatus {
  running: boolean;
  /** Files visited by the current pass. */
  done: number;
  /** Files currently stored in the index. */
  indexed: number;
  error: string | null;
}
export interface FullTextSearchPreviewPage {
  text: string;
  location: string;
  offset: number;
  nextOffset: number | null;
  previousOffset: number | null;
}
