"use client";

import { Component, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { formatOmpUiForm, initialOmpUiValues, parseOmpUi, type OmpUiNode } from "@/lib/omp-ui";
import { formatOmpUiActionMessage, OmpUiActionContext } from "@/lib/omp-ui-actions";
import { ConfirmDialog, Field } from "@/components/ui/field";
import { CodeBlock } from "@/components/MermaidBlock";

type Props = { code: string; isStreaming?: boolean; actionsEnabled?: boolean };
type Send = ((message: string) => Promise<boolean>) | null;

class OmpUiBoundary extends Component<{ code: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="omp-ui"><p role="alert">Не удалось показать OMP UI. Доступен исходник.</p><CodeBlock code={this.props.code} lang="omp-ui" /></div>;
    return this.props.children;
  }
}

export function OmpUiBlock({ code, isStreaming = false, actionsEnabled = false }: Props) {
  const send = useContext(OmpUiActionContext);
  const [scope, setScope] = useState({ send, revision: 0 });
  // A capability outage is not a new owner; preserve edits until the owner actually changes.
  if (send && scope.send !== send) {
    setScope({ send, revision: scope.revision + (scope.send ? 1 : 0) });
    return null;
  }
  return <OmpUiBoundary key={`${scope.revision}:${code}`} code={code}>
    <OmpUiDocument code={code} isStreaming={isStreaming} send={actionsEnabled && !isStreaming ? send : null} />
  </OmpUiBoundary>;
}

function OmpUiDocument({ code, isStreaming, send }: { code: string; isStreaming: boolean; send: Send }) {
  const parsed = useMemo(() => isStreaming ? null : parseOmpUi(code), [code, isStreaming]);
  const [source, setSource] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const pending = useRef(false);
  const request = useRef(0);
  const [capability, setCapability] = useState({ send });
  const mounted = useRef(true);
  const { copied, copy } = useCopyFeedback();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (capability.send !== send) {
    setCapability({ send });
    setPreview(null);
    setFeedback("");
    setBusy(false);
    pending.current = false;
    request.current++;
    return null;
  }

  async function confirm() {
    if (!send || preview === null || pending.current) return;
    const token = ++request.current;
    pending.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const accepted = await send(preview);
      if (!mounted.current || token !== request.current) return;
      if (accepted) {
        setPreview(null);
        setFeedback("Сообщение отправлено.");
      } else setFeedback("Не удалось отправить сообщение. Проверьте подключение и текущую сессию.");
    } catch (error) {
      if (mounted.current && token === request.current) setFeedback(error instanceof Error ? error.message : "Не удалось отправить сообщение.");
    } finally {
      if (token === request.current) {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  if (isStreaming) return <CodeBlock code={code} lang="omp-ui" isStreaming />;
  if (!parsed?.node) return <div className="omp-ui"><p role="alert">OMP UI: {parsed?.error ?? "Некорректный документ."}</p><CodeBlock code={code} lang="omp-ui" /></div>;
  const toggle = <button type="button" className="markdown-code-action" aria-pressed={source} onClick={() => setSource(!source)}>{source ? "Показать интерфейс" : "Показать исходник"}</button>;
  return <div className="omp-ui">
    {source && <CodeBlock code={code} lang="omp-ui" headerAction={toggle} />}
    <div hidden={source}>
      <div className="omp-ui-toolbar"><span>OMP UI</span><div>{toggle}<button type="button" onClick={() => copy(code)}>{copied ? "Скопировано" : "Копировать исходник"}</button></div></div>
      {!send && <p className="omp-ui-hint">Только просмотр: действия доступны в подключённой активной сессии ассистента.</p>}
      <CatalogNode node={parsed.node} disabled={!send || busy || preview !== null} onPreview={(message) => { if (send && !pending.current) { setFeedback(""); setPreview(message); } }} />
    </div>
    {feedback && preview === null && <p role="status">{feedback}</p>}
    <ConfirmDialog open={preview !== null} onOpenChange={(open) => { if (!open && !pending.current) setPreview(null); }} title="Отправить сообщение в сессию?" description={<><span>{preview === null ? "" : formatOmpUiActionMessage(preview)}</span>{feedback && <span className="omp-ui-confirm-error" role="alert">{feedback}</span>}</>} confirmLabel={busy ? "Отправка…" : "Подтвердить отправку"} cancelLabel="Отмена" busy={busy} onConfirm={() => { void confirm(); }} />
  </div>;
}

const STEP_LABELS: Record<string, string> = { pending: "Ожидает", active: "Выполняется", done: "Готово", error: "Ошибка" };
const TONE_LABELS: Record<string, string> = { neutral: "Информация", success: "Успех", warning: "Предупреждение", error: "Ошибка" };
type NodeProps = { node: OmpUiNode; disabled: boolean; onPreview: (message: string) => void };

function CatalogNode({ node, disabled, onPreview }: NodeProps): ReactNode {
  switch (node.type) {
    case "panel": return <section className="omp-ui-panel">{node.title && <h3>{node.title}</h3>}<div className="omp-ui-stack">{node.items.map((child, index) => <CatalogNode key={index} node={child} disabled={disabled} onPreview={onPreview} />)}</div></section>;
    case "text": return <p className="omp-ui-text">{node.text}</p>;
    case "stat": return <div className={`omp-ui-stat omp-ui-tone-${node.tone ?? "neutral"}`}><span>{node.label}</span><strong>{String(node.value)}{node.unit && <small> {node.unit}</small>}</strong>{node.tone && <small>{TONE_LABELS[node.tone]}</small>}</div>;
    case "keyvalue": return <dl className="omp-ui-keyvalue">{node.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{String(item.value)}</dd></div>)}</dl>;
    case "table": return <div className="omp-ui-table-scroll" tabIndex={0} role="region" aria-label={node.title || "Таблица"}><table>{node.title && <caption>{node.title}</caption>}<thead><tr>{node.columns.map((column, index) => <th scope="col" key={index}>{column}</th>)}</tr></thead><tbody>{node.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{String(cell)}</td>)}</tr>)}</tbody></table></div>;
    case "steps": return <ol className="omp-ui-steps">{node.items.map((item, index) => <li key={index} className={`omp-ui-step-${item.status}`} aria-current={item.status === "active" ? "step" : undefined}><strong>{item.label}</strong><span>{STEP_LABELS[item.status]}</span>{item.description && <p>{item.description}</p>}</li>)}</ol>;
    case "chart": return <Chart node={node} />;
    case "action": return <button className="omp-ui-submit" type="button" disabled={disabled} onClick={() => onPreview(node.message)}>{node.label}</button>;
    case "form": return <OmpForm node={node} disabled={disabled} onPreview={onPreview} />;
  }
}

function Chart({ node }: { node: Extract<OmpUiNode, { type: "chart" }> }) {
  // Normalize first so even opposite Number.MAX_VALUE values cannot overflow the domain.
  let scale = 0;
  let minimum = 0;
  let maximum = 0;
  for (const point of node.data) {
    scale = Math.max(scale, Math.abs(point.value));
    minimum = Math.min(minimum, point.value);
    maximum = Math.max(maximum, point.value);
  }
  scale ||= 1;
  const low = minimum / scale;
  const high = maximum / scale || (low === 0 ? 1 : 0);
  const y = (value: number) => 20 + (high - value / scale) / (high - low) * 160;
  const zero = y(0);
  const width = 440 / Math.max(1, node.data.length);
  return <figure className="omp-ui-chart">
    <figcaption>{node.title || "График"}</figcaption>
    {node.data.length === 0 ? <p>Нет данных.</p> : <svg viewBox="0 0 520 215" role="img" aria-label={`${node.title || "График"}: ${node.kind === "bar" ? "столбчатый" : "линейный"}. Данные в таблице ниже.`}>
      <line className="omp-ui-axis" x1="55" x2="495" y1={zero} y2={zero} />
      <text x="5" y="17">{String(high * scale)}</text><text x="5" y="200">{String(low * scale)}</text>
      {node.kind === "bar" ? node.data.map((point, index) => <rect key={index} x={55 + width * index + width * 0.15} y={Math.min(zero, y(point.value))} width={width * 0.7} height={Math.abs(zero - y(point.value))}><title>{point.label}: {point.value}</title></rect>) : <>
        <polyline fill="none" points={node.data.map((point, index) => `${node.data.length === 1 ? 275 : 55 + 440 * index / (node.data.length - 1)},${y(point.value)}`).join(" ")} />
        {node.data.map((point, index) => <circle key={index} cx={node.data.length === 1 ? 275 : 55 + 440 * index / (node.data.length - 1)} cy={y(point.value)} r="3"><title>{point.label}: {point.value}</title></circle>)}
      </>}
    </svg>}
    <details><summary>Данные графика</summary><div className="omp-ui-table-scroll" tabIndex={0} role="region" aria-label="Данные графика"><table><caption>{node.title || "Данные графика"}</caption><thead><tr><th scope="col">Метка</th><th scope="col">Значение</th></tr></thead><tbody>{node.data.map((point, index) => <tr key={index}><td>{point.label}</td><td>{point.value}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

function OmpForm({ node, disabled, onPreview }: { node: Extract<OmpUiNode, { type: "form" }>; disabled: boolean; onPreview: (message: string) => void }) {
  const id = useId();
  const [values, setValues] = useState(() => initialOmpUiValues(node.fields));
  const [error, setError] = useState("");
  const errorId = `${id}-error`;
  return <form className="omp-ui-form" noValidate aria-label={node.title || "Форма OMP UI"} onSubmit={(event) => {
    event.preventDefault();
    if (disabled) return;
    const result = formatOmpUiForm(node, values);
    if (result.error !== undefined) { setError(result.error); return; }
    if (!event.currentTarget.reportValidity()) { setError("Проверьте значения полей."); return; }
    setError("");
    onPreview(result.message);
  }}>
    {node.title && <h3>{node.title}</h3>}
    <p className="omp-ui-hint">Не вводите пароли, токены и другие секреты. Перед отправкой будет показан текст сообщения.</p>
    <fieldset disabled={disabled} aria-describedby={error ? errorId : undefined}>
      <legend className="omp-ui-sr-only">{node.title || "Поля формы"}</legend>
      {node.fields.map((field) => <Field key={field.name} id={`${id}-${field.name}`} label={field.label} required={field.required}>
        {field.type === "select" ? <select id={`${id}-${field.name}`} name={field.name} required={field.required} value={String(values[field.name])} onChange={(event) => { setError(""); setValues({ ...values, [field.name]: event.target.value }); }}><option value="">Выберите…</option>{field.options?.filter((option) => option !== "").map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input id={`${id}-${field.name}`} name={field.name} type={field.type} required={field.required} maxLength={field.type === "text" ? 4000 : undefined} autoComplete="off" min={field.min ?? (field.type === "range" ? 0 : undefined)} max={field.max ?? (field.type === "range" ? 100 : undefined)} step={field.step ?? (field.type === "number" ? "any" : field.type === "range" ? 1 : undefined)} value={field.type === "checkbox" ? undefined : String(values[field.name])} checked={field.type === "checkbox" ? values[field.name] === true : undefined} onChange={(event) => { setError(""); setValues({ ...values, [field.name]: field.type === "checkbox" ? event.target.checked : event.target.value }); }} />}
      </Field>)}
    </fieldset>
    {error && <p id={errorId} role="alert">{error}</p>}
    <button type="submit" className="omp-ui-submit" disabled={disabled}>{node.submitLabel || "Проверить и отправить"}</button>
  </form>;
}
