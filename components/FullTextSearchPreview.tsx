"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FullTextSearchPreviewPage, FullTextSearchResult } from "@/lib/full-text-search-types";
import { useI18n } from "@/lib/i18n";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    parts.push(text.slice(start, index), <mark key={index} style={{ background: "var(--accent)", color: "var(--bg)", borderRadius: 2 }}>{match[0]}</mark>);
    start = index + match[0].length;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

export function FullTextSearchPreview({ result, query, onClose, onOpenFile }: {
  result: FullTextSearchResult;
  query: string;
  onClose: () => void;
  onOpenFile?: (filePath: string, location?: string, query?: string) => void;
}) {
  const { t } = useI18n();
  const [offset, setOffset] = useState(Math.max(0, result.offset - 100));
  const [page, setPage] = useState<FullTextSearchPreviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null); setPage(null);
    const params = new URLSearchParams({ source: result.source, section: String(result.section), offset: String(offset) });
    if (result.entryId) params.set("entryId", result.entryId);
    void fetch(`/api/search/preview?${params}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const data = await response.json() as FullTextSearchPreviewPage & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted) setPage(data);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("fullTextSearch.previewFailed"));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [result.source, result.section, result.entryId, offset, t]);
  return (
    <section ref={panelRef} tabIndex={-1} aria-label={t("fullTextSearch.previewLabel")} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg-panel)", minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 140, overflowWrap: "anywhere" }}>
          <strong>{result.title}</strong>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{page?.location ?? result.location}</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{result.kind === "archive" ? t("fullTextSearch.previewArchive") : result.kind === "file" ? t("fullTextSearch.previewFile", { path: result.filePath ?? "" }) : t("fullTextSearch.previewMessage")}</div>
        </div>
        {result.filePath && onOpenFile && <button className="ui-focus-ring" type="button" onClick={() => onOpenFile(result.filePath!, result.location, query)}>{t("fullTextSearch.openFile")}</button>}
        <button className="ui-focus-ring" type="button" aria-label={t("fullTextSearch.closePreview")} onClick={onClose}>{t("fullTextSearch.closePreview")}</button>
      </div>
      {busy && <div role="status">{t("fullTextSearch.previewLoading")} <button type="button" onClick={() => { request.current?.abort(); setBusy(false); setError(t("fullTextSearch.previewCancelled")); }}>{t("fullTextSearch.cancelPreview")}</button></div>}
      {error && <p role="alert">{error}</p>}
      {page && <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <button type="button" disabled={page.offset === 0} onClick={() => setOffset(0)}>{t("fullTextSearch.previewStart", { what: result.kind === "file" ? t("fullTextSearch.section") : t("fullTextSearch.message") })}</button>
          <button type="button" disabled={page.previousOffset === null} onClick={() => setOffset(page.previousOffset!)}>{t("fullTextSearch.previewPrevious")}</button>
          <button type="button" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>{t("fullTextSearch.previewMore")}</button>
          <span role="status" style={{ color: "var(--text-muted)", fontSize: 12 }}>{page.nextOffset !== null ? t("fullTextSearch.previewMoreAvailable") : t("fullTextSearch.previewEnd")} · {t("fullTextSearch.character", { number: page.offset + 1 })}</span>
        </div>
        <pre tabIndex={0} aria-label={t("fullTextSearch.previewContent")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "45vh", overflow: "auto", fontSize: 12, margin: 0 }}><SearchHighlight text={page.text} query={query} /></pre>
      </>}
    </section>
  );
}
