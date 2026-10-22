"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import type { SessionInfo } from "@/lib/types";
import type { FullTextSearchPage, FullTextSearchResult } from "@/lib/full-text-search-types";
import type { IndexStatus } from "@/lib/full-text-search";
import { navigateToSearchMessage } from "@/lib/full-text-search-navigation";
import { FullTextSearchPreview, SearchHighlight } from "./FullTextSearchPreview";

export function FullTextSearch({ onClose, onSelectSession, onOpenFile }: {
  onClose: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onOpenFile?: (filePath: string, location?: string, query?: string) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose });
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [page, setPage] = useState<FullTextSearchPage | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FullTextSearchResult | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  // Show initial index progress without leaving it stale during later searches.
  useEffect(() => {
    if (!busy) return;
    let active = true;
    const timer = setInterval(() => {
      const controller = request.current;
      void fetch("/api/search/status", { cache: "no-store", signal: controller?.signal }).then((response) => response.json()).then((data: Pick<IndexStatus, "phase" | "done">) => {
        if (!active || controller?.signal.aborted || controller !== request.current) return;
        setStatus(data.phase === "building"
          ? t("fullTextSearch.indexing", { count: data.done })
          : t("fullTextSearch.searching"));
      }).catch(() => {});
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [busy, t]);

  const search = async (text: string, nextCursor = 0) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null); setStatus(t("fullTextSearch.searching")); setPreview(null);
    setPage(null); setSearchedQuery(text.trim()); setCursor(nextCursor);
    try {
      const response = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: text, cursor: nextCursor }), signal: controller.signal, cache: "no-store" });
      const data = await response.json() as FullTextSearchPage & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      setPage(data);
      setStatus(data.results.length
        ? `${t("fullTextSearch.matches", { from: nextCursor + 1, to: nextCursor + data.results.length })} ${data.nextCursor !== null ? t("fullTextSearch.moreAvailable") : t("fullTextSearch.complete")}`
        : t("fullTextSearch.noMatches"));
    } catch (cause) {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : t("fullTextSearch.failed")); setStatus(t("fullTextSearch.failed")); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  const open = (result: FullTextSearchResult) => {
    if (result.kind === "message" && result.session) {
      navigateToSearchMessage(result, searchedQuery);
      onSelectSession(result.session);
      onClose();
    } else setPreview(result);
  };

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="full-text-search-title" tabIndex={-1} style={{ width: 900, maxWidth: "100%", maxHeight: "90dvh", overflow: "auto", padding: 20, borderRadius: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 id="full-text-search-title" style={{ fontSize: 18, margin: "0 0 12px" }}>{t("fullTextSearch.title")}</h2>
          <button type="button" aria-label={t("fullTextSearch.close")} onClick={onClose}>{t("fullTextSearch.close")}</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("fullTextSearch.description")}</p>
        <form onSubmit={(event) => { event.preventDefault(); void search(query); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label htmlFor="full-text-search-query" style={{ width: "100%", fontSize: 12 }}>{t("fullTextSearch.label")}</label>
          <input id="full-text-search-query" type="search" maxLength={256} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("fullTextSearch.placeholder")} style={{ flex: 1, minWidth: 120, padding: 8, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 }} />
          <button type="submit" disabled={!query.trim()}>{t("fullTextSearch.submit")}</button>
          {busy && <button type="button" onClick={() => { request.current?.abort(); setBusy(false); setStatus(t("fullTextSearch.cancelled")); }}>{t("fullTextSearch.cancel")}</button>}
        </form>
        <p role="status" aria-live="polite">{status}</p>
        {error && <p role="alert">{error}</p>}
        {!!page?.warningCount && <details role="alert" style={{ marginBottom: 8 }}><summary style={{ cursor: "pointer", fontSize: 12 }}><strong>{t("fullTextSearch.incomplete", { count: page.warningCount })}</strong></summary><ul style={{ fontSize: 12, color: "var(--text-muted)" }}>{page.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{page.warningCount > page.warnings.length && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("fullTextSearch.additionalErrors", { count: page.warningCount - page.warnings.length })}</p>}</details>}
        {preview && <FullTextSearchPreview key={`${preview.source}:${preview.section}:${preview.offset}`} result={preview} query={searchedQuery} onClose={() => setPreview(null)} onOpenFile={onOpenFile} />}
        <ol aria-label="Full text search results" start={cursor + 1} style={{ paddingLeft: 24 }}>
          {page?.results.map((result, index) => <li key={`${result.source}:${result.section}:${result.offset}`} style={{ marginBottom: 12 }}>
            <button type="button" onClick={() => open(result)} style={{ width: "100%", textAlign: "left", padding: 12, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 }}>
              <strong>{result.title}</strong><span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 12 }}>{result.kind === "archive" ? t("fullTextSearch.archiveKind") : result.kind === "file" ? t("fullTextSearch.fileKind") : t("fullTextSearch.messageKind")}</span>
              <div style={{ color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>{result.filePath ?? result.session?.cwd} · {result.location}</div>
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 5, fontSize: 12 }}><SearchHighlight text={result.snippet} query={searchedQuery} /></div>
              <span className="sr-only">{t("fullTextSearch.openMatch", { number: cursor + index + 1 })}</span>
            </button>
          </li>)}
        </ol>
        {page && <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={cursor === 0 || busy} onClick={() => void search(searchedQuery, Math.max(0, cursor - 50))}>{t("fullTextSearch.previous")}</button>
          <button type="button" disabled={page.nextCursor === null || busy} onClick={() => void search(searchedQuery, page.nextCursor!)}>{t("fullTextSearch.more")}</button>
        </div>}
      </div>
    </div>, document.body,
  );
}
