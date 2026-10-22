import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createJiti } from "jiti";
import { promises as fsPromises } from "node:fs";

// All fixtures, including parser-created documents, stay inside the approved checkout.
test("full text search covers complete sessions, archives, documents and hostile boundaries", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".full-text-search-test-"));
  const agent = path.join(root, "agent-state");
  const project = path.join(root, "project");
  const sessions = path.join(agent, "sessions", "workspace");
  const archives = path.join(agent, "archive", "sessions", "workspace");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  process.env.GIT_CEILING_DIRECTORIES = root;
  for (const dir of [project, sessions, archives]) mkdirSync(dir, { recursive: true });
  const header = (id) => ({ type: "session", id, cwd: project, timestamp: "2026-10-21T00:00:00Z" });
  const entry = (id, message) => ({ type: "message", id, message });
  const jsonl = (items) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  const unicodeCases = [
    ["ΟΣ", "οσ"],
    ["Σ", "ς"],
    ["𐐀a", "𐐨A"],
    ["𐐀", "𐐨"],
    ["ſ", "s"],
    ["K", "k"],
    ["aſK", "ASK"],
    ["aſK", "ask"],
    ["ASK", "aſK"],
    ["prefix ΟΣ suffix", "PREFIX οσ SUFFIX"],
    ["[ΟΣ].*?", "[οσ].*?"],
    ["a\0b", "a\0b"],
    ["İ", "i"],
  ];
  const activePath = path.join(sessions, "active.jsonl");
  const archivePath = path.join(archives, "old.jsonl.gz");
  writeFileSync(activePath, jsonl([
    header("active-session"),
    ...unicodeCases.map(([text], index) => entry(`unicode-${index}`, { role: "user", content: text })),
    entry("unicode-oversized", { role: "user", content: "x".repeat(1_000_001) + " oversized ΟΣ" }),
    entry("first", { role: "user", content: "First unrelated prompt" }),
    entry("deep-tool", { role: "toolResult", content: [{ type: "text", text: "x".repeat(180000) + " SEARCH_NEEDLE active tool tail" }] }),
    entry("object-tool", { role: "toolResult", content: [], details: { data: { stdout: "SEARCH_NEEDLE structured tool output" }, password: "CREDENTIAL_NEVER_VISIBLE" } }),
    entry("image", { role: "assistant", content: [{ type: "image", data: "CREDENTIAL_NEVER_VISIBLE" }] }),
    { type: "custom_message", id: "custom-entry", content: "TRANSCRIPT_EXTRA_MARKER custom content", display: true },
    { type: "branch_summary", id: "summary-entry", summary: "TRANSCRIPT_EXTRA_MARKER previous branch" },
    { type: "compaction", id: "compacted-entry", summary: "TRANSCRIPT_EXTRA_MARKER compacted context" },
  ]));
  writeFileSync(archivePath, gzipSync(jsonl([
    header("archived-session"),
    entry("old-prompt", { role: "user", content: "Old prompt" }),
    entry("archived-tool", { role: "bashExecution", command: "echo archived", output: "z".repeat(180000) + " SEARCH_NEEDLE archived tool tail" }),
  ])));
  const originalArchive = readFileSync(archivePath);
  writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, addedAt: "2026-10-21T00:00:00Z", hidden: false }] }));
  writeFileSync(path.join(project, "deep.log"), "padding\n".repeat(20000) + "SEARCH_NEEDLE deep project line\n");
  writeFileSync(path.join(project, "Cargo.lock"), "SEARCH_NEEDLE unknown text suffix\n");
  writeFileSync(path.join(project, "boundary.txt"), "x".repeat(16380) + "boundaryToken\n");
  writeFileSync(path.join(project, "pages.csv"), Array.from({ length: 61 }, (_, i) => `PAGINATED_MATCH,row ${i}`).join("\n"));
  writeFileSync(path.join(project, ".env"), "CREDENTIAL_NEVER_VISIBLE");
  writeFileSync(path.join(project, ".credentials.yaml"), "CREDENTIAL_NEVER_VISIBLE");
  writeFileSync(path.join(project, ".git-credentials"), "CREDENTIAL_NEVER_VISIBLE");
  writeFileSync(path.join(project, "models.yml"), "CREDENTIAL_NEVER_VISIBLE");
  writeFileSync(path.join(root, "outside.txt"), "CREDENTIAL_NEVER_VISIBLE");
  symlinkSync(path.join(root, "outside.txt"), path.join(project, "escape.txt"));
  symlinkSync(path.dirname(archives), path.join(agent, "archive", "sessions", "linked"));
  execFileSync("python3", ["-B", "-c", `import sys, os\nimport fitz\nfrom docx import Document\nfrom openpyxl import Workbook\np=sys.argv[1]\nd=fitz.open(); page=d.new_page(); page.insert_text((72,72),'SEARCH_NEEDLE PDF page'); d.save(os.path.join(p,'report.pdf')); d.close()\nd=Document(); d.add_paragraph('Intro'); d.add_paragraph('SEARCH_NEEDLE Word paragraph'); d.save(os.path.join(p,'report.docx'))\nw=Workbook(); s=w.active; s.title='Evidence'; s.append(['Intro']); s.append(['SEARCH_NEEDLE spreadsheet']); w.save(os.path.join(p,'report.xlsx')); w.close()`, project], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText, readSearchPreview } = await jiti.import("./full-text-search.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    allowFileRoot(project);
    const result = await searchFullText("SEARCH_NEEDLE");
    for (const [index, [text, needle]] of unicodeCases.entries()) {
      const matches = (await searchFullText(needle)).results.filter((item) => item.entryId === `unicode-${index}`);
      if (index === unicodeCases.length - 1) {
        assert.equal(matches.length, 0, "literal Unicode case folding must not turn dotted I into i");
      } else {
        assert.equal(matches.length, 1, `${JSON.stringify(needle)} must find ${JSON.stringify(text)}`);
        const match = matches[0];
        assert.equal(match.snippet.slice(match.matchStart, match.matchEnd), text.slice(match.offset, match.offset + needle.length));
      }
    }
    assert.deepEqual((await searchFullText("OVERSIZED οσ")).results.map((item) => item.entryId), ["unicode-oversized"], "oversized sections use the same Unicode literal scan");
    assert.equal(result.warningCount, 0, result.warnings.join("\n"));
    assert.equal(result.results.length, 8);
    assert.ok(result.results.some((item) => item.entryId === "deep-tool" && item.offset > 128000));
    assert.ok(result.results.some((item) => item.entryId === "object-tool"));
    const archived = result.results.find((item) => item.entryId === "archived-tool");
    assert.equal(archived.kind, "archive");
    assert.ok(result.results.some((item) => item.location.startsWith("Line 20001")));
    assert.ok(result.results.some((item) => item.location.startsWith("Page 1")));
    assert.ok(result.results.some((item) => item.location.startsWith("Paragraph 2")));
    assert.ok(result.results.some((item) => item.location.startsWith("Sheet Evidence, row 2")));
    for (const item of result.results) {
      assert.equal(item.snippet.slice(item.matchStart, item.matchEnd).toUpperCase(), "SEARCH_NEEDLE");
      const preview = await readSearchPreview(item.source, item.section, Math.max(0, item.offset - 10), undefined, item.entryId);
      assert.match(preview.text, /SEARCH_NEEDLE/);
    }
    const fullArchive = await readSearchPreview(archived.source, 999, 0, undefined, archived.entryId);
    assert.ok(fullArchive.nextOffset !== null, "full message is paginated, not truncated");
    assert.match((await readSearchPreview(archived.source, archived.section, archived.offset, undefined, archived.entryId)).text, /SEARCH_NEEDLE archived tool tail/);
    assert.deepEqual(readFileSync(archivePath), originalArchive, "preview does not restore or change archives");
    assert.equal(existsSync(path.join(sessions, "old.jsonl")), false);
    const boundary = await searchFullText("boundaryToken");
    assert.equal(boundary.results.length, 1, "matches spanning parser frames remain searchable");
    assert.match((await readSearchPreview(boundary.results[0].source, boundary.results[0].section, 0)).text, /boundaryToken/);
    const first = await searchFullText("PAGINATED_MATCH");
    assert.equal(first.results.length, 50);
    assert.equal(first.nextCursor, 50);
    const second = await searchFullText("PAGINATED_MATCH", { cursor: first.nextCursor });
    assert.equal(second.results.length, 11);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.results, ...second.results].map((item) => `${item.section}:${item.offset}`)).size, 61);
    assert.deepEqual((await searchFullText("TRANSCRIPT_EXTRA_MARKER")).results.map((item) => item.entryId).sort(), ["compacted-entry", "custom-entry", "summary-entry"]);
    assert.equal((await searchFullText("CREDENTIAL_NEVER_VISIBLE")).results.length, 0);
    for (const source of ["file:/etc/passwd", `file:${path.join(project, ".env")}`, `file:${path.join(project, "models.yml")}`, `file:${path.join(project, "escape.txt")}`, "archive:../outside.jsonl.gz", "archive:linked/workspace/old.jsonl.gz"]) {
      await assert.rejects(readSearchPreview(source, 0, 0), /denied|symbolic|Invalid/);
    }
    const deniedFile = path.join(project, "unreadable.txt");
    const deniedDirectory = path.join(project, "unreadable-directory");
    writeFileSync(deniedFile, "PARTIAL_SEARCH_MARKER");
    writeFileSync(path.join(project, "readable.txt"), "PARTIAL_SEARCH_MARKER");
    mkdirSync(deniedDirectory);
    const originalOpen = fsPromises.open, originalOpendir = fsPromises.opendir;
    const denied = () => Object.assign(new Error("Permission denied for test source"), { code: "EACCES" });
    fsPromises.open = async (file, ...args) => {
      if (String(file) === deniedFile) throw denied();
      return originalOpen(file, ...args);
    };
    fsPromises.opendir = async (file, ...args) => {
      if (String(file) === deniedDirectory) throw denied();
      return originalOpendir(file, ...args);
    };
    try {
      const partial = await searchFullText("PARTIAL_SEARCH_MARKER");
      assert.equal(partial.warningCount, 2);
      assert.deepEqual(partial.results.map(item => path.basename(item.filePath)), ["readable.txt"]);
    } finally {
      fsPromises.open = originalOpen;
      fsPromises.opendir = originalOpendir;
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(searchFullText("needle", { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(readSearchPreview(archived.source, 0, 0, controller.signal), { name: "AbortError" });
    await assert.rejects(searchFullText(" "), /1–256/);
    await assert.rejects(searchFullText("needle", { cursor: -1 }), /cursor/);
    const largePath = path.join(sessions, "large.jsonl");
    writeFileSync(largePath, jsonl([header("large-session"), entry("large-tool", { role: "toolResult", content: [{ type: "text", text: "x".repeat(34 * 1024 * 1024) + " LATE_LARGE_MARKER" }] })]));
    const large = await searchFullText("LATE_LARGE_MARKER");
    assert.equal(large.warningCount, 0, large.warnings.join("\n"));
    assert.equal(large.results.length, 1);
    assert.equal(large.results[0].entryId, "large-tool");
    assert.ok(large.results[0].offset > 32 * 1024 * 1024, "valid entries are not capped at an arbitrary first-byte budget");
    const runningController = new AbortController();
    const cancelled = searchFullText("unmatched-large-entry", { signal: runningController.signal });
    setTimeout(() => runningController.abort(), 1);
    await assert.rejects(cancelled, { name: "AbortError" });
    rmSync(largePath);
    writeFileSync(path.join(archives, "broken.jsonl.gz"), "not gzip");
    writeFileSync(path.join(sessions, "bad-utf8.jsonl"), Buffer.from([0xff, 0xfe, 0x0a]));
    const incomplete = await searchFullText("no_such_match");
    assert.ok(incomplete.warningCount > 0);
    assert.match(incomplete.warnings.join(" "), /broken/);
    assert.match(incomplete.warnings.join(" "), /bad-utf8/);
    const { POST } = await jiti.import("../app/api/search/route.ts");
    assert.equal((await POST(new Request("http://localhost/api/search", { method: "POST", body: JSON.stringify({ query: "needle", cursor: -1 }) }))).status, 400);
    assert.equal((await POST(new Request("http://localhost/api/search", { method: "POST", body: "x".repeat(4097) }))).status, 413);
  } finally {
    clearInterval(globalThis.__ompSearchIndexTimer);
    await globalThis.__ompSearchIndexPass;
    await globalThis.__ompSearchIndexWrite;
    globalThis.__ompSearchIndex?.close();
    for (const key of Object.keys(globalThis)) if (key.startsWith("__ompSearchIndex")) delete globalThis[key];
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = oldCache;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});
