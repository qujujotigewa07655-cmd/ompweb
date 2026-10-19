import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { OmpUiBlock } = await jiti.import("./OmpUiBlock.tsx");
const { OmpUiActionContext } = await jiti.import("../lib/omp-ui-actions.ts");
afterEach(cleanup);
function ui(node, { send = null, enabled = true, streaming = false, code = JSON.stringify(node) } = {}) {
  return React.createElement(OmpUiActionContext.Provider, { value: send }, React.createElement(OmpUiBlock, { code, actionsEnabled: enabled, isStreaming: streaming }));
}
const action = { type: "action", label: "Запросить", message: "/literal-not-command\n<img src=x onerror=alert(1)>" };
const form = { type: "form", title: "Параметры", message: "Использовать параметры", fields: [
  { name: "title", label: "Название", type: "text", required: true },
  { name: "count", label: "Число", type: "number", min: -2, max: 2, step: 0.5, value: 0 },
  { name: "optional", label: "Необязательное число", type: "number" },
  { name: "day", label: "Дата", type: "date", value: "2024-02-29" },
  { name: "pick", label: "Вариант", type: "select", options: ["A", "B"], value: "B" },
  { name: "check", label: "Согласие", type: "checkbox", required: true },
  { name: "level", label: "Уровень", type: "range", min: -10, max: 0, step: 2 },
] };

test("catalog renders escaped scalar data and readonly controls without any HTML or asset loads", () => {
  const unsafe = '<img src="https://example.test/track" onerror="alert(1)">';
  const view = render(ui({ type: "panel", title: "Обзор", items: [
    { type: "text", text: unsafe },
    { type: "stat", label: "Показатель", value: 0, unit: "%", tone: "warning" },
    { type: "keyvalue", items: [{ label: "Флаг", value: false }, { label: "Пусто", value: null }] },
    { type: "table", title: "Результат", columns: ["Данные", "Количество"], rows: [[unsafe, -2]] },
    { type: "steps", items: [{ label: "Подготовка", status: "done" }, { label: "Работа", status: "active" }, { label: "Проверка", status: "error" }] },
    { type: "chart", kind: "line", data: [{ label: unsafe, value: 0 }] },
    action, form,
  ] }));
  assert.equal(screen.getByRole("heading", { name: "Обзор" }).textContent, "Обзор");
  assert.equal(screen.getByRole("button", { name: "Запросить" }).disabled, true);
  assert.equal(screen.getByLabelText(/^Название/).matches(":disabled"), true);
  assert.equal(screen.getByRole("button", { name: "Проверить и отправить" }).disabled, true);
  assert.ok(screen.getByText(/Только просмотр/));
  assert.ok(screen.getByText("false"));
  assert.ok(screen.getByText("null"));
  assert.ok(screen.getByText("Предупреждение"));
  assert.equal(screen.getByText("Работа").closest("li").getAttribute("aria-current"), "step");
  assert.ok(screen.getByText("Готово"));
  assert.ok(screen.getByText("Ошибка"));
  assert.ok(screen.getAllByText(unsafe).length >= 2);
  assert.equal(view.container.querySelector("img, script, iframe, a, [onerror]"), null);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("streaming and invalid documents show the original source rather than a partial live interface", () => {
  const code = JSON.stringify(action);
  const send = async () => { throw new Error("must not send"); };
  const view = render(ui(action, { send, streaming: true }));
  assert.equal(view.container.querySelector("pre code").textContent, code);
  assert.equal(screen.queryByRole("button", { name: "Запросить" }), null);
  assert.equal(screen.queryByRole("alert"), null);
  const invalid = JSON.stringify({ type: "panel", items: [{ type: "text", text: "must not partially render" }, { type: "html", text: "<script>x</script>" }] });
  view.rerender(ui(null, { send, code: invalid }));
  assert.match(screen.getByRole("alert").textContent, /Неизвестный тип/);
  assert.equal(screen.queryByText("must not partially render", { selector: "p" }), null);
  assert.equal(view.container.querySelector("pre code").textContent, invalid);
});

test("bar and line charts handle mixed, negative, zero, singleton and extreme finite domains", () => {
  for (const kind of ["bar", "line"]) {
    for (const values of [[-10, 0, 20], [-10, -5], [0, 0], [0], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
      const view = render(ui({ type: "chart", title: "Измерения", kind, data: values.map((value, i) => ({ label: `Точка ${i}`, value })) }));
      const svg = screen.getByRole("img");
      assert.match(svg.getAttribute("aria-label"), /Данные в таблице/);
      for (const element of svg.querySelectorAll("[x], [y], [height], [width], [cx], [cy]")) {
        for (const attribute of ["x", "y", "height", "width", "cx", "cy"]) {
          if (element.hasAttribute(attribute)) assert.ok(Number.isFinite(Number(element.getAttribute(attribute))), `${kind} ${attribute}`);
        }
      }
      if (kind === "bar") {
        const bars = [...svg.querySelectorAll("rect")];
        const zero = Number(svg.querySelector("line").getAttribute("y1"));
        assert.equal(bars.length, values.length);
        bars.forEach((bar, i) => {
          const y = Number(bar.getAttribute("y"));
          const height = Number(bar.getAttribute("height"));
          assert.ok(height >= 0);
          if (values[i] < 0) assert.equal(y, zero);
          if (values[i] > 0) assert.ok(y < zero);
          if (values[i] === 0) assert.equal(height, 0);
        });
      } else {
        assert.equal(svg.querySelectorAll("circle").length, values.length);
        assert.doesNotMatch(svg.querySelector("polyline").getAttribute("points"), /NaN|Infinity/);
      }
      fireEvent.click(screen.getByText("Данные графика", { selector: "summary" }));
      const table = screen.getByRole("table");
      assert.equal(within(table).getAllByRole("row").length, values.length + 1);
      values.forEach((value, index) => assert.equal(within(table).getAllByRole("row")[index + 1].lastElementChild.textContent, String(value)));
      view.unmount();
    }
  }
});

test("action preview shows exact wrapped literal text, cancellation emits nothing, pending double clicks emit once", async () => {
  const messages = [];
  let resolve;
  const send = (message) => { messages.push(message); return new Promise((done) => { resolve = done; }); };
  render(ui(action, { send }));
  fireEvent.click(screen.getByRole("button", { name: "Запросить" }));
  assert.deepEqual(messages, []);
  assert.ok(screen.getByRole("dialog").textContent.includes(`OMP UI — действие пользователя:\n${action.message}`));
  assert.equal(screen.getByRole("dialog").querySelector("img"), null);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  assert.deepEqual(messages, []);
  fireEvent.click(screen.getByRole("button", { name: "Запросить" }));
  const confirm = screen.getByRole("button", { name: "Подтвердить отправку" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  assert.deepEqual(messages, [action.message]);
  assert.equal(screen.getByRole("button", { name: "Отправка…" }).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  assert.ok(screen.getByRole("dialog"));
  await act(async () => { resolve(true); });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.match(screen.getByRole("status").textContent, /отправлено/);
});

test("native forms preserve typed defaults and validate before preview or send", async () => {
  const messages = [];
  const send = async (message) => { messages.push(message); return true; };
  render(ui(form, { send }));
  assert.equal(screen.getByLabelText(/^Число/).value, "0");
  assert.equal(screen.getByLabelText("Дата").value, "2024-02-29");
  assert.equal(screen.getByLabelText("Вариант").value, "B");
  assert.equal(screen.getByLabelText(/^Согласие/).checked, false);
  assert.equal(screen.getByLabelText("Уровень").value, "-10");
  assert.equal(screen.getByLabelText(/^Число/).getAttribute("step"), "0.5");
  const formElement = screen.getByRole("form", { name: "Параметры" });
  fireEvent.submit(formElement);
  assert.match(screen.getByRole("alert").textContent, /Название.*Обязательное/);
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.change(screen.getByLabelText(/^Название/), { target: { value: '<script>"literal"</script>' } });
  fireEvent.click(screen.getByLabelText(/^Согласие/));
  for (const invalid of ["3", "0.25"]) {
    fireEvent.change(screen.getByLabelText(/^Число/), { target: { value: invalid } });
    fireEvent.submit(formElement);
    assert.ok(screen.getByRole("alert"));
    assert.equal(screen.queryByRole("dialog"), null);
  }
  fireEvent.change(screen.getByLabelText(/^Число/), { target: { value: "-1.5" } });
  fireEvent.submit(formElement);
  assert.deepEqual(messages, []);
  const expected = `${form.message}\n${JSON.stringify({ title: '<script>"literal"</script>', count: -1.5, optional: null, day: "2024-02-29", pick: "B", check: true, level: -10 }, null, 2)}`;
  assert.ok(screen.getByRole("dialog").textContent.includes(`OMP UI — действие пользователя:\n${expected}`));
  assert.equal(screen.getByRole("dialog").querySelector("script"), null);
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  await waitFor(() => assert.deepEqual(messages, [expected]));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(screen.getByLabelText(/^Название/).value, '<script>"literal"</script>');
});

test("failed sends retain editable form values and expose the error inside confirmation", async () => {
  const send = async () => { throw new Error("Соединение потеряно"); };
  const node = { type: "form", message: "Сохранить", fields: [{ name: "answer", label: "Ответ", type: "text", value: "initial" }] };
  render(ui(node, { send }));
  fireEvent.change(screen.getByLabelText("Ответ"), { target: { value: "edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  await waitFor(() => assert.match(within(screen.getByRole("dialog")).getByRole("alert").textContent, /Соединение потеряно/));
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  assert.equal(screen.getByLabelText("Ответ").value, "edited");
  assert.equal(screen.getByRole("button", { name: "Проверить и отправить" }).disabled, false);
});

test("source view preserves edits, clipboard receives original JSON, source and owner changes reset pending UI", async (t) => {
  const node = { type: "form", message: "Сохранить", fields: [{ name: "answer", label: "Ответ", type: "text", value: "initial" }] };
  const code = JSON.stringify(node);
  const send = async () => true;
  const sentToClipboard = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { sentToClipboard.push(text); } } });
  t.after(() => { if (previous) Object.defineProperty(navigator, "clipboard", previous); else delete navigator.clipboard; });
  const view = render(ui(node, { send }));
  fireEvent.change(screen.getByLabelText("Ответ"), { target: { value: "edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Копировать исходник" }));
  await waitFor(() => assert.deepEqual(sentToClipboard, [code]));
  fireEvent.click(screen.getByRole("button", { name: "Показать исходник" }));
  assert.equal(view.container.querySelector("pre code").textContent, code);
  fireEvent.click(screen.getByRole("button", { name: "Показать интерфейс" }));
  assert.equal(screen.getByLabelText("Ответ").value, "edited");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  assert.ok(screen.getByRole("dialog"));
  const nextOwner = async () => true;
  view.rerender(ui(node, { send: nextOwner }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByLabelText("Ответ").value, "initial");
  fireEvent.change(screen.getByLabelText("Ответ"), { target: { value: "new owner edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  view.rerender(ui({ ...node, message: "Другой исходник" }, { send: nextOwner }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByLabelText("Ответ").value, "initial");
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  view.rerender(ui({ ...node, message: "Другой исходник" }, { send: nextOwner, enabled: false }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByRole("button", { name: "Проверить и отправить" }).disabled, true);
});

test("a rejected action stays previewable and an old in-flight response cannot update a new owner", async () => {
  const unavailable = async () => false;
  const view = render(ui(action, { send: unavailable }));
  fireEvent.click(screen.getByRole("button", { name: "Запросить" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  await waitFor(() => assert.match(within(screen.getByRole("dialog")).getByRole("alert").textContent, /Не удалось отправить/));
  assert.equal(screen.getByRole("button", { name: "Подтвердить отправку" }).disabled, false);
  let resolve;
  const oldOwner = () => new Promise((done) => { resolve = done; });
  view.rerender(ui(action, { send: oldOwner }));
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.click(screen.getByRole("button", { name: "Запросить" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  assert.equal(screen.getByRole("button", { name: "Отправка…" }).disabled, true);
  const nextOwner = async () => true;
  view.rerender(ui(action, { send: nextOwner }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByRole("button", { name: "Запросить" }).disabled, false);
  await act(async () => { resolve(true); });
  assert.equal(screen.queryByRole("status"), null);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("same-session availability loss clears confirmation without discarding edits or accepting stale responses", async () => {
  const node = { type: "form", message: "Сохранить", fields: [{ name: "answer", label: "Ответ", type: "text", value: "initial" }] };
  const responses = [];
  const send = () => new Promise((resolve) => { responses.push(resolve); });
  const view = render(ui(node, { send }));
  fireEvent.change(screen.getByLabelText("Ответ"), { target: { value: "keep this edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  view.rerender(ui(node));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByLabelText("Ответ").value, "keep this edit");
  assert.equal(screen.getByLabelText("Ответ").matches(":disabled"), true);
  view.rerender(ui(node, { send }));
  assert.equal(screen.getByLabelText("Ответ").value, "keep this edit");
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.click(screen.getByRole("button", { name: "Проверить и отправить" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отправку" }));
  assert.equal(responses.length, 2);
  await act(async () => { responses[0](true); });
  assert.equal(screen.getByRole("button", { name: "Отправка…" }).disabled, true);
  assert.equal(screen.queryByRole("status"), null);
  await act(async () => { responses[1](false); });
  assert.match(within(screen.getByRole("dialog")).getByRole("alert").textContent, /Не удалось отправить/);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  assert.equal(screen.getByLabelText("Ответ").value, "keep this edit");
  view.rerender(ui(node, { send, enabled: false }));
  assert.equal(screen.getByLabelText("Ответ").value, "keep this edit");
  assert.equal(screen.getByRole("button", { name: "Проверить и отправить" }).disabled, true);
});
