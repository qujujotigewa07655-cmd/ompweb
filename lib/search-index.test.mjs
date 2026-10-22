import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The index is a cache of parsed transcripts: whatever it serves must match the
// files on disk after every search, including edits, new files and deletions.
test("search index follows file edits, additions and deletions", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".search-index-test-"));
  const agent = path.join(root, "agent-state");
  const project = path.join(root, "project");
  const sessions = path.join(agent, "sessions", "workspace");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  for (const dir of [project, sessions]) mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(sessions, "one.jsonl");
  const projectFile = path.join(project, "notes.txt");
  const jsonl = (text) => [JSON.stringify({ type: "session", id: "s1", cwd: project, timestamp: "2026-10-21T00:00:00Z" }), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: text } })].join("\n") + "\n";
  writeFileSync(sessionPath, jsonl("STALE_MARKER original ЕВРОПА Über"));
  writeFileSync(projectFile, "PROJECT_MARKER first version\n");
  writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, addedAt: "2026-10-21T00:00:00Z", hidden: false }] }));
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText, readSearchPreview } = await jiti.import("./full-text-search.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    allowFileRoot(project);

    // SQLite's lower() folds ASCII only; a Unicode needle must not be filtered
    // out before the JavaScript regex sees the row.
    assert.equal((await searchFullText("европа")).results.length, 1);
    assert.equal((await searchFullText("über")).results.length, 1);
    assert.equal((await searchFullText("ЕВРОПА")).results.length, 1);

    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 1);
    assert.equal((await searchFullText("FRESH_MARKER")).results.length, 0);

    writeFileSync(sessionPath, jsonl("FRESH_MARKER rewritten"));
    const fresh = await searchFullText("FRESH_MARKER");
    assert.equal(fresh.results.length, 1, "edited transcripts are reindexed");
    assert.equal((await searchFullText("STALE_MARKER")).results.length, 0, "replaced text is dropped from the index");

    const added = path.join(sessions, "two.jsonl");
    writeFileSync(added, jsonl("ADDED_MARKER new session"));
    assert.equal((await searchFullText("ADDED_MARKER")).results.length, 1, "new files are indexed");

    rmSync(added);
    assert.equal((await searchFullText("ADDED_MARKER")).results.length, 0, "deleted files leave the index");

    // Project files are refreshed in the background, so an edit becomes visible
    // once the background pass has run — not immediately.
    writeFileSync(projectFile, "PROJECT_MARKER second version\n");
    const { ensureProjectRefresh } = await jiti.import("./search-index.ts");
    await ensureProjectRefresh();
    const projectHits = (await searchFullText("PROJECT_MARKER")).results;
    assert.equal(projectHits.length, 1);
    assert.match((await readSearchPreview(projectHits[0].source, projectHits[0].section, projectHits[0].offset)).text, /second version/);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = oldCache;
    rmSync(root, { recursive: true, force: true });
  }
});
