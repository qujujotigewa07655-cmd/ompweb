"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import { ClickableImage } from "./ImageLightbox";
import type { ImageProvider, ImageProviderOption } from "@/lib/image-generation";
interface SavedImage { path: string; url: string; downloadUrl: string; provider: string; model: string; prompt: string; createdAt: string; }

export function ImageGenerationDialog({ cwd, onClose, onOpenFile }: {
  cwd: string | null;
  onClose: () => void;
  onOpenFile: (file: string) => void;
}) {
  const { t } = useI18n();
  const dialog = useModalDialog<HTMLDivElement>({ onClose });
  const [providers, setProviders] = useState<ImageProviderOption[]>([]);
  const [provider, setProvider] = useState<ImageProvider>("openai");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<SavedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef<AbortController | null>(null);
  const selected = providers.find((option) => option.id === provider);

  useEffect(() => {
    const controller = new AbortController();
    generation.current?.abort();
    generation.current = null;
    setBusy(false);
    setError(null);
    setLoading(true);
    setImages([]);
    void fetch(`/api/image-generation${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || t("imageGeneration.loadFailed"));
        if (!controller.signal.aborted) {
          setProviders(body.providers);
          setImages(body.images);
          const available = (body.providers as ImageProviderOption[]).find((option) => option.available);
          if (available) { setProvider(available.id); setModel(available.model); }
        }
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("imageGeneration.loadError")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      generation.current?.abort();
      generation.current = null;
    };
  }, [cwd, t]);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!cwd) { setError(t("imageGeneration.pickProject")); return; }
    if (!selected?.available) { setError(selected?.reason || t("imageGeneration.subscriptionUnavailable")); return; }
    const controller = new AbortController();
    generation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/image-generation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, provider, model, prompt }), signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t("imageGeneration.failed"));
      if (controller.signal.aborted || generation.current !== controller) return;
      setImages((previous) => [...body.images, ...previous]);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("imageGeneration.generateError"));
    } finally {
      if (generation.current === controller) generation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "#0009", display: "grid", placeItems: "center", padding: 12 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="image-generation-title" style={{ width: "min(760px, 100%)", maxHeight: "90dvh", overflowY: "auto", padding: 20, borderRadius: 12, border: "1px solid var(--border)", color: "var(--text)", background: "var(--bg-panel)", minWidth: 0 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 id="image-generation-title" style={{ margin: 0 }}>{t("imageGeneration.title")}</h2>
          <button type="button" className="ui-focus-ring" onClick={onClose} aria-label={t("imageGeneration.close")}>×</button>
        </header>
        <p style={{ overflowWrap: "anywhere" }}>{cwd ? t("imageGeneration.project", { cwd }) : t("imageGeneration.pickProjectFirst")}</p>
        <form onSubmit={(event) => void generate(event)} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <label htmlFor="image-provider">{t("imageGeneration.provider")}</label>
          <select id="image-provider" disabled={busy || loading} value={provider} onChange={(event) => {
            const next = providers.find((option) => option.id === event.target.value);
            if (next) { setProvider(next.id); setModel(next.model); setError(null); }
          }}>
            {providers.length ? providers.map((option) => <option key={option.id} value={option.id}>{option.name}{option.available ? "" : ` — ${t("imageGeneration.signInRequired")}`}</option>) : <option>{t("imageGeneration.loading")}</option>}
          </select>
          <label htmlFor="image-model">{provider === "openai" ? t("imageGeneration.gptModel") : t("imageGeneration.geminiModel")}</label>
          <select id="image-model" value={model} required disabled={busy || loading || !selected?.available} onChange={(event) => setModel(event.target.value)}>
            {selected?.models.length ? selected.models.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>) : <option value="">{t("imageGeneration.noModels")}</option>}
          </select>
          <label htmlFor="image-prompt">{t("imageGeneration.prompt")}</label>
          <textarea id="image-prompt" value={prompt} required maxLength={32000} rows={4} disabled={busy} onChange={(event) => setPrompt(event.target.value)} aria-describedby="image-api-cost" style={{ resize: "vertical", minWidth: 0 }} />
          <p id="image-api-cost" style={{ margin: 0, color: "var(--text-muted)" }}>{t("imageGeneration.costNotice")}</p>
          {selected && !selected.available && <p role="status" style={{ margin: 0 }}>{selected.reason}</p>}
          {error && <p role="alert" style={{ color: "var(--status-error)", margin: 0 }}>{error}</p>}
          <button type="submit" className="ui-focus-ring" disabled={busy || loading || !cwd || !selected?.available}>{busy ? t("imageGeneration.busy") : t("imageGeneration.create")}</button>
          {busy && <p role="status">{t("imageGeneration.cancelHint")}</p>}
        </form>
        <section aria-label={t("imageGeneration.savedImages")} style={{ display: "grid", gap: 18, marginTop: 20 }}>
          {images.map((image) => <figure key={image.path} style={{ margin: 0, minWidth: 0 }}>
            <ClickableImage src={image.url} alt={image.prompt} style={{ maxWidth: "100%", maxHeight: 420, objectFit: "contain" }} />
            <figcaption style={{ overflowWrap: "anywhere" }}>{image.prompt} · {image.model}</figcaption>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              <a className="ui-focus-ring" href={image.downloadUrl} download>{t("imageGeneration.download")}</a>
              <button type="button" className="ui-focus-ring" onClick={() => onOpenFile(image.path)}>{t("imageGeneration.openFile")}</button>
            </div>
          </figure>)}
        </section>
      </div>
    </div>, document.body,
  );
}
