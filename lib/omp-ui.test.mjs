import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseOmpUi, initialOmpUiValues, formatOmpUiForm } = await jiti.import("./omp-ui.ts");
const parse = (node) => parseOmpUi(JSON.stringify(node));
const form = (fields) => ({ type: "form", message: "Параметры", fields });

test("closed catalog accepts all nine components without changing scalar data", () => {
  const node = { type: "panel", title: "Панель", items: [
    { type: "text", text: "<script>alert(1)</script>" },
    { type: "stat", label: "Ноль", value: 0, unit: "%", tone: "warning" },
    { type: "keyvalue", items: [{ label: "Флаг", value: false }, { label: "Пусто", value: null }] },
    { type: "table", columns: ["A", "B"], rows: [[false, null], ["<img src=x>", -3]] },
    { type: "steps", items: [{ label: "Шаг", status: "active", description: "Описание" }] },
    { type: "chart", kind: "line", data: [{ label: "Минус", value: -10 }, { label: "Ноль", value: 0 }] },
    { type: "action", label: "Запрос", message: "/not-a-command" },
    form([{ name: "count", label: "Число", type: "number", value: 0 }]),
  ] };
  assert.deepEqual(parse(node), { node });
});

test("invalid siblings and executable or unknown properties reject the whole document", () => {
  for (const node of [
    null, [], "text", { type: "html", html: "<b>raw</b>" },
    { type: "text", text: "ok", onClick: "alert(1)" },
    { type: "text", text: "ok", href: "https://example.test" },
    { type: "panel", items: [{ type: "text", text: "ok" }, { type: "rpc", method: "exec" }] },
    { type: "table", columns: ["one"], rows: [[1, 2]] },
    { type: "table", columns: ["one"], rows: [[{ html: "x" }]] },
    { type: "keyvalue", items: [{ label: "x", value: [1] }] },
    { type: "chart", kind: "pie", data: [] },
    { type: "steps", items: [{ label: "x", status: "unknown" }] },
  ]) {
    const result = parse(node);
    assert.equal(result.node, undefined, JSON.stringify(node));
    assert.equal(typeof result.error, "string");
  }
  assert.match(parseOmpUi('{"type":"chart","kind":"bar","data":[{"label":"x","value":1e999}]}').error, /число/);
  assert.match(parseOmpUi('{"type":"text","text":"x","__proto__":{"polluted":true}}').error, /свойство/);
  assert.equal({}.polluted, undefined);
  assert.match(parseOmpUi("{unfinished").error, /JSON/);
});

test("document, nesting, collection and string limits are explicit", () => {
  assert.match(parseOmpUi(" ".repeat(50001)).error, /50 000/);
  assert.ok(parse({ type: "text", text: "x".repeat(4000) }).node);
  assert.ok(parse({ type: "text", text: "x".repeat(4001) }).error);
  assert.ok(parse({ type: "panel", items: Array.from({ length: 99 }, () => ({ type: "text", text: "x" })) }).node);
  assert.ok(parse({ type: "panel", items: Array.from({ length: 100 }, () => ({ type: "text", text: "x" })) }).error);
  let nested = { type: "text", text: "x" };
  for (let i = 0; i < 5; i++) nested = { type: "panel", items: [nested] };
  assert.ok(parse(nested).node);
  assert.ok(parse({ type: "panel", items: [nested] }).error);
  const table = { type: "table", columns: Array(20).fill("c"), rows: Array.from({ length: 200 }, () => Array(20).fill(0)) };
  assert.ok(parse(table).node);
  assert.ok(parse({ ...table, rows: [...table.rows, table.rows[0]] }).error);
  assert.ok(parse({ ...table, columns: Array(21).fill("c"), rows: [] }).error);
  const chart = { type: "chart", kind: "bar", data: Array.from({ length: 200 }, (_, i) => ({ label: String(i), value: i - 100 })) };
  assert.ok(parse(chart).node);
  assert.ok(parse({ ...chart, data: [...chart.data, chart.data[0]] }).error);
  const fields = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, label: "Поле", type: "text" }));
  assert.ok(parse(form(fields)).node);
  assert.ok(parse(form([...fields, { ...fields[0], name: "extra" }])).error);
  assert.ok(parse(form([{ name: "pick", label: "Вариант", type: "select", options: Array.from({ length: 100 }, (_, i) => String(i)) }])).node);
  assert.ok(parse(form([{ name: "pick", label: "Вариант", type: "select", options: Array.from({ length: 101 }, (_, i) => String(i)) }])).error);
});

test("field names, types, bounds, dates and typed defaults are validated together", () => {
  const base = { name: "field", label: "Поле", type: "text" };
  for (const field of [
    { ...base, name: "__proto__" }, { ...base, name: "constructor" }, { ...base, name: "prototype" }, { ...base, name: "x.y" },
    { ...base, type: "password" }, { ...base, type: "file" }, { ...base, required: "yes" },
    { ...base, value: false }, { ...base, options: ["a"] }, { ...base, min: 0 },
    { ...base, type: "checkbox", value: "false" },
    { ...base, type: "number", value: "4" }, { ...base, type: "number", min: 3, max: 2 },
    { ...base, type: "number", step: 0 }, { ...base, type: "number", step: -1 },
    { ...base, type: "number", min: 0, max: 2, value: 3 },
    { ...base, type: "number", min: 1, step: 2, value: 2 },
    { ...base, type: "range", min: 101 },
    { ...base, type: "date", value: "2026-02-30" }, { ...base, type: "date", value: "not-a-date" },
    { ...base, type: "select", options: [] }, { ...base, type: "select", options: ["a", "a"] },
    { ...base, type: "select", options: ["a"], value: "b" },
  ]) assert.ok(parse(form([field])).error, JSON.stringify(field));
  assert.ok(parse(form([base, base])).error);
  assert.ok(parse(form([{ ...base, type: "date", value: "2024-02-29" }])).node);
  assert.ok(parse(form([{ ...base, type: "number", min: -1, step: 0.1, value: -0.7 }])).node);
});

test("form formatting produces typed JSON and rejects invalid input without losing values", () => {
  const node = form([
    { name: "text", label: "Текст", type: "text", required: true },
    { name: "count", label: "Число", type: "number", value: 0, min: -2, max: 2, step: 0.5 },
    { name: "optional", label: "Необязательное", type: "number" },
    { name: "date", label: "Дата", type: "date", value: "2024-02-29" },
    { name: "pick", label: "Вариант", type: "select", options: ["A", "B"], value: "B" },
    { name: "check", label: "Согласие", type: "checkbox", required: true },
    { name: "range", label: "Диапазон", type: "range", min: -10, max: 0, step: 2 },
  ]);
  assert.ok(parse(node).node);
  const defaults = initialOmpUiValues(node.fields);
  assert.deepEqual(defaults, { text: "", count: "0", optional: "", date: "2024-02-29", pick: "B", check: false, range: "-10" });
  const values = { ...defaults, text: '<b>"safe"</b>\n!shell', check: true };
  const result = formatOmpUiForm(node, values);
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.message.slice(node.message.length + 1)), { ...values, count: 0, optional: null, range: -10 });
  assert.deepEqual(values, { ...defaults, text: '<b>"safe"</b>\n!shell', check: true });
  for (const [name, value] of [["text", ""], ["count", "3"], ["count", "0.25"], ["count", "Infinity"], ["date", "2026-02-30"], ["date", "x"], ["pick", "outside"], ["check", false], ["range", "-9"]]) {
    assert.ok(formatOmpUiForm(node, { ...values, [name]: value }).error, `${name}: ${value}`);
  }
});
