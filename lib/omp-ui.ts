export type OmpUiScalar = string | number | boolean | null;
export type OmpUiField = {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox" | "range";
  value?: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};
export type OmpUiNode =
  | { type: "panel"; title?: string; items: OmpUiNode[] }
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string | number; unit?: string; tone?: "neutral" | "success" | "warning" | "error" }
  | { type: "keyvalue"; items: { label: string; value: OmpUiScalar }[] }
  | { type: "table"; title?: string; columns: string[]; rows: OmpUiScalar[][] }
  | { type: "steps"; items: { label: string; description?: string; status: "pending" | "active" | "done" | "error" }[] }
  | { type: "chart"; title?: string; kind: "bar" | "line"; data: { label: string; value: number }[] }
  | { type: "action"; label: string; message: string }
  | { type: "form"; title?: string; fields: OmpUiField[]; message: string; submitLabel?: string };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Ожидается объект.");
  for (const key of Object.keys(value)) requireValue(keys.includes(key), `Неизвестное свойство: ${key.slice(0, 64)}.`);
}
function text(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.length <= 4000, "Ожидается строка до 4000 символов.");
}
function optionalText(value: unknown) {
  if (value !== undefined) text(value);
}
function finite(value: unknown): asserts value is number {
  requireValue(typeof value === "number" && Number.isFinite(value), "Ожидается конечное число.");
}
function list(value: unknown, max: number): asserts value is unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, `Ожидается массив не более ${max} элементов.`);
}
function scalar(value: unknown): asserts value is OmpUiScalar {
  if (typeof value === "string") text(value);
  else requireValue(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), "Допустимы только строки, числа, boolean и null.");
}
function validDate(value: string) {
  const date = new Date(value);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !value.startsWith("0000") && Number.isFinite(date.getTime()) && date.toISOString() === `${value}T00:00:00.000Z`;
}
function numericError(field: OmpUiField, value: number): string | null {
  if (!Number.isFinite(value)) return "Введите конечное число.";
  const min = field.min ?? (field.type === "range" ? 0 : undefined);
  const max = field.max ?? (field.type === "range" ? 100 : undefined);
  if (min !== undefined && value < min) return `Минимум: ${min}.`;
  if (max !== undefined && value > max) return `Максимум: ${max}.`;
  const step = field.step ?? (field.type === "range" ? 1 : undefined);
  if (step !== undefined) {
    const remainder = (value - (min ?? 0)) / step;
    if (!Number.isFinite(remainder) || Math.abs(remainder - Math.round(remainder)) > 1e-7) return `Шаг: ${step}.`;
  }
  return null;
}
function validateField(value: unknown): asserts value is OmpUiField {
  object(value, ["name", "label", "type", "value", "required", "min", "max", "step", "options"]);
  text(value.name);
  requireValue(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value.name) && !["__proto__", "constructor", "prototype"].includes(value.name), "Недопустимое имя поля.");
  text(value.label);
  requireValue(["text", "number", "date", "select", "checkbox", "range"].includes(value.type as string), "Неизвестный тип поля.");
  requireValue(value.required === undefined || typeof value.required === "boolean", "required должен быть boolean.");
  const numeric = value.type === "number" || value.type === "range";
  for (const key of ["min", "max", "step"] as const) {
    if (value[key] !== undefined) {
      requireValue(numeric, "min/max/step допустимы только для числовых полей.");
      finite(value[key]);
    }
  }
  if (value.step !== undefined) requireValue((value.step as number) > 0, "Шаг должен быть положительным.");
  const min = value.min ?? (value.type === "range" ? 0 : undefined);
  const max = value.max ?? (value.type === "range" ? 100 : undefined);
  requireValue(min === undefined || max === undefined || (min as number) <= (max as number), "min не может превышать max.");
  if (value.type === "select") {
    list(value.options, 100);
    requireValue(value.options.length > 0, "У select должны быть варианты.");
    value.options.forEach(text);
    requireValue(new Set(value.options).size === value.options.length, "Варианты select должны быть уникальны.");
  } else requireValue(value.options === undefined, "options допустимы только для select.");
  if (value.value !== undefined) {
    if (numeric) {
      finite(value.value);
      requireValue(!numericError(value as unknown as OmpUiField, value.value), "Начальное число не соответствует ограничениям поля.");
    } else if (value.type === "checkbox") requireValue(typeof value.value === "boolean", "Значение checkbox должно быть boolean.");
    else {
      text(value.value);
      if (value.type === "date" && value.value !== "") requireValue(validDate(value.value), "Недопустимая начальная дата.");
      if (value.type === "select") requireValue(value.value === "" || (value.options as string[]).includes(value.value), "Начальный вариант отсутствует в options.");
    }
  }
}

export function parseOmpUi(source: string): { node: OmpUiNode; error?: never } | { node?: never; error: string } {
  if (source.length > 50000) return { error: "Исходник превышает 50 000 символов." };
  try {
    const root: unknown = JSON.parse(source);
    let count = 0;
    function visit(value: unknown, depth: number) {
      requireValue(++count <= 100 && depth <= 6, "Превышен лимит: 100 компонентов или 6 уровней.");
      object(value, ["type", "title", "items", "text", "label", "value", "unit", "tone", "columns", "rows", "kind", "data", "message", "fields", "submitLabel"]);
      switch (value.type) {
        case "panel":
          object(value, ["type", "title", "items"]); optionalText(value.title); list(value.items, 100);
          value.items.forEach((item) => visit(item, depth + 1)); break;
        case "text":
          object(value, ["type", "text"]); text(value.text); break;
        case "stat":
          object(value, ["type", "label", "value", "unit", "tone"]); text(value.label); optionalText(value.unit);
          if (typeof value.value === "string") text(value.value); else finite(value.value);
          requireValue(value.tone === undefined || ["neutral", "success", "warning", "error"].includes(value.tone as string), "Неизвестный тон stat."); break;
        case "keyvalue":
          object(value, ["type", "items"]); list(value.items, 200);
          value.items.forEach((item) => { object(item, ["label", "value"]); text(item.label); scalar(item.value); }); break;
        case "table":
          object(value, ["type", "title", "columns", "rows"]); optionalText(value.title); list(value.columns, 20);
          requireValue(value.columns.length > 0, "У таблицы должны быть столбцы."); value.columns.forEach(text); list(value.rows, 200);
          value.rows.forEach((row) => { list(row, 20); requireValue(row.length === (value.columns as unknown[]).length, "Ширина строки не совпадает с числом столбцов."); row.forEach(scalar); }); break;
        case "steps":
          object(value, ["type", "items"]); list(value.items, 100);
          value.items.forEach((item) => { object(item, ["label", "description", "status"]); text(item.label); optionalText(item.description); requireValue(["pending", "active", "done", "error"].includes(item.status as string), "Неизвестный статус шага."); }); break;
        case "chart":
          object(value, ["type", "title", "kind", "data"]); optionalText(value.title);
          requireValue(value.kind === "bar" || value.kind === "line", "Поддерживаются только bar и line."); list(value.data, 200);
          value.data.forEach((point) => { object(point, ["label", "value"]); text(point.label); finite(point.value); }); break;
        case "action":
          object(value, ["type", "label", "message"]); text(value.label); text(value.message);
          requireValue(value.message.trim().length > 0, "Сообщение действия не может быть пустым."); break;
        case "form": {
          object(value, ["type", "title", "fields", "message", "submitLabel"]); optionalText(value.title); optionalText(value.submitLabel); text(value.message);
          requireValue(value.message.trim().length > 0, "Сообщение формы не может быть пустым."); list(value.fields, 20); value.fields.forEach(validateField);
          const names = value.fields.map((field) => (field as OmpUiField).name);
          requireValue(new Set(names).size === names.length, "Имена полей должны быть уникальны."); break;
        }
        default: throw new Error("Неизвестный тип компонента.");
      }
    }
    visit(root, 1);
    return { node: root as OmpUiNode };
  } catch (error) {
    return { error: error instanceof SyntaxError ? "Некорректный JSON." : error instanceof Error ? error.message : "Некорректный документ." };
  }
}

export function initialOmpUiValues(fields: OmpUiField[]): Record<string, string | boolean> {
  return Object.fromEntries(fields.map((field) => [field.name, field.type === "checkbox" ? field.value === true : String(field.value ?? (field.type === "range" ? field.min ?? 0 : ""))]));
}

export function formatOmpUiForm(form: Extract<OmpUiNode, { type: "form" }>, values: Record<string, string | boolean>): { message: string; error?: never } | { message?: never; error: string } {
  const typed: Record<string, OmpUiScalar> = {};
  for (const field of form.fields) {
    const value = values[field.name];
    let result: OmpUiScalar;
    let error: string | null = null;
    if (field.type === "checkbox") {
      if (typeof value !== "boolean") return { error: `${field.label}: недопустимое значение.` };
      result = value === true;
      if (field.required && !result) error = "Отметьте поле.";
    } else {
      if (typeof value !== "string" || value.length > 4000) return { error: `${field.label}: недопустимое значение.` };
      result = value;
      if (field.required && !value.trim()) error = "Обязательное поле.";
      else if (field.type === "number" || field.type === "range") {
        result = value.trim() === "" ? null : Number(value);
        if (result !== null) error = numericError(field, result);
        else if (field.type === "range") error = "Укажите число.";
      } else if (field.type === "date" && value && !validDate(value)) error = "Введите дату ГГГГ-ММ-ДД.";
      else if (field.type === "select" && value && !field.options?.includes(value)) error = "Выберите вариант из списка.";
    }
    if (error) return { error: `${field.label}: ${error}` };
    typed[field.name] = result;
  }
  return { message: `${form.message}\n${JSON.stringify(typed, null, 2)}` };
}
