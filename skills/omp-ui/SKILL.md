---
name: omp-ui
description: Use when the user wants OMPWeb inline cards, dashboards, metric panels, interactive forms or action buttons. Render verified data with the native omp-ui JSON fence. Not for ordinary prose, terminal-only output, or architecture diagrams that Mermaid already covers.
compatibility: OMPWeb with the OMP UI renderer; other clients show the JSON as code.
---

# OMP UI

Use one completed `omp-ui` Markdown fence containing one JSON object. Put related items in a `panel`. Explain significant findings in ordinary prose; the card is a presentation of verified data, not a replacement for evidence. Never invent measurements. Do not emit partial objects, HTML, JavaScript, expressions, URLs, RPC commands, or secret-entry forms. Do not copy the `dsh-ui` protocol: these schemas are different.

## Catalog

- `panel`: `type`, optional `title`, `items` (nodes).
- `text`: `type`, `text` (plain text, not HTML).
- `stat`: `type`, `label`, `value` (string or number), optional `unit`, optional `tone` (`neutral`, `success`, `warning`, `error`). Keep numbers numeric; do not reinterpret localized decimal strings.
- `keyvalue`: `type`, `items` containing `{ "label": "...", "value": "..." }`; values may also be numbers, booleans or null.
- `table`: `type`, optional `title`, `columns` (strings), `rows` (arrays of scalar cells, exactly one per column).
- `steps`: `type`, `items` containing `label`, optional `description`, and `status` (`pending`, `active`, `done`, `error`). These are displayed steps, not the agent's task tracker.
- `chart`: `type`, optional `title`, `kind` (`bar` or `line`), `data` containing `{ "label": "...", "value": 12.5 }`. Values are finite numbers; negative and zero values are supported. Charts include an accessible data view.
- `action`: `type`, `label`, `message` (an ordinary request for the agent). The user previews and confirms the request before it is sent.
- `form`: `type`, optional `title`, `message`, optional `submitLabel`, `fields`. Each field has a unique safe `name`, visible `label`, `type` (`text`, `number`, `date`, `select`, `checkbox`, `range`), optional typed `value`, optional `required`. Numeric/range fields may use `min`, `max`, `step`; select fields need `options` (strings). No password or file fields. The confirmed submission sends the request plus typed JSON values once; field editing does not call the agent.

## Limits and behavior

Keep source below 50,000 characters, nesting at most 6, total nodes at most 100. Tables: at most 200 rows/20 columns. Charts: at most 200 points. Forms: at most 20 fields; selects: at most 100 options. Strings and action requests: at most 4,000 characters.

Unknown types or malformed data show the original source with an error rather than a partial card. While the assistant is streaming, the block remains code. Cards in files and read-only conversations cannot send actions. Actions belong to the displayed main session; they never choose a session ID, execute shell commands directly, or grant permission to mutate infrastructure. Existing stand read-only policy still applies.

For complex standalone visualizations beyond this catalog, create a self-contained HTML file and open it through the existing file viewer. Do not weaken Markdown sanitization.

## Example: metrics and an explicit next request

```omp-ui
{
  "type": "panel",
  "title": "Example data — not live measurements",
  "items": [
    {"type": "stat", "label": "Messages", "value": 1240, "unit": "items", "tone": "warning"},
    {"type": "chart", "title": "Example queue changes", "kind": "line", "data": [{"label": "10:00", "value": 800}, {"label": "10:05", "value": 1240}]},
    {"type": "table", "columns": ["Metric", "Value"], "rows": [["Messages", 1240], ["Consumers", 2]]},
    {"type": "action", "label": "Explain the changes", "message": "Explain the queue changes from the data in this card. Do not change infrastructure."}
  ]
}
```

## Example: a form

```omp-ui
{
  "type": "form",
  "title": "Choose the analysis scope",
  "message": "Analyze the selected period using the submitted values. Read-only investigation.",
  "submitLabel": "Prepare request",
  "fields": [
    {"name": "period", "label": "Period", "type": "select", "options": ["Last hour", "Last day"], "value": "Last hour", "required": true},
    {"name": "limit", "label": "Maximum results", "type": "number", "min": 1, "max": 100, "step": 1, "value": 20},
    {"name": "errors_only", "label": "Errors only", "type": "checkbox", "value": true}
  ]
}
```
