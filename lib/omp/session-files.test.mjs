import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanSessionInfo } = await jiti.import("./session-files.ts");

test("finds the first user text beyond large service records without changing explicit titles", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-session-list-"));
  const path = join(dir, "session.jsonl");
  try {
    const entries = [
      { type: "title", title: "My title" },
      { type: "session", id: "delayed-user", cwd: dir, timestamp: "2026-10-12T00:00:00Z" },
      { type: "custom_message", customType: "xdev-mount-notice", content: "Я".repeat(100_000) },
      { type: "message", message: { role: "assistant", content: "Not the title" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Первый вопрос" }, { type: "image", data: "x".repeat(100_000) }] } },
      { type: "message", message: { role: "user", content: "Second question" } },
    ];
    writeFileSync(path, entries.map(JSON.stringify).join("\n") + "\n");
    const info = scanSessionInfo(path);
    assert.equal(info.firstMessage, "Первый вопрос");
    assert.equal(info.title, "My title");
    writeFileSync(path, entries.slice(0, 3).map(JSON.stringify).join("\n"));
    assert.equal(scanSessionInfo(path).firstMessage, "(no messages)");
    writeFileSync(path, [entries[1], { type: "message", message: { role: "user", content: "Final unterminated line" } }].map(JSON.stringify).join("\n"));
    assert.equal(scanSessionInfo(path, false).firstMessage, "Final unterminated line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caps the list preview so a memory preamble cannot dominate the payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-session-preview-"));
  const path = join(dir, "session.jsonl");
  try {
    const preamble = `<memory>\n${"row of recalled context\n".repeat(600)}</memory>`;
    writeFileSync(path, [
      { type: "session", id: "memory-session", cwd: dir, timestamp: "2026-10-12T00:00:00Z" },
      { type: "message", message: { role: "user", content: preamble } },
    ].map(JSON.stringify).join("\n") + "\n");
    const info = scanSessionInfo(path);
    // 200 characters plus the ellipsis: the sidebar renders 50 of them, while
    // the shipped list keeps enough to search across.
    assert.equal(info.firstMessage.length, 201);
    assert.ok(info.firstMessage.startsWith("<memory>"));
    assert.ok(info.firstMessage.endsWith("…"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
