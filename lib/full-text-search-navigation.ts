import type { FullTextSearchResult } from "./full-text-search-types";

export const SEARCH_MESSAGE_EVENT = "ompweb:search-message";
export interface SearchMessageTarget { result: FullTextSearchResult; query: string }
let pending: SearchMessageTarget | null = null;

/** Retained across ChatWindow's session-key remount, without persisting transcripts. */
export function navigateToSearchMessage(result: FullTextSearchResult, query: string): void {
  pending = { result, query };
  window.dispatchEvent(new Event(SEARCH_MESSAGE_EVENT));
}

export function getSearchMessageTarget(sessionId: string | undefined): SearchMessageTarget | null {
  return sessionId && pending?.result.session?.id === sessionId ? pending : null;
}

export function clearSearchMessageTarget(sessionId: string | undefined): void {
  if (pending?.result.session?.id === sessionId) pending = null;
}
