import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The index must reflect edits, additions, binary transitions and deletions
// without reading managed roots through a symbolic link.
test("search index follows source changes and rejects symlink roots", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".search-index-test-"));
  const agent = path.join(root, "agent-state");
  const project = path.join(root, "project");
  const sessions = path.join(agent, "sessions", "workspace");
  const linkedTarget = path.join(root, "linked-target");
  const linkedRoot = path.join(root, "linked-project");
  const parentTarget = path.join(root, "parent-target");
  const linkedParent = path.join(root, "linked-parent");
  const parentRoot = path.join(linkedParent, "project");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  process.env.GIT_CEILING_DIRECTORIES = root;
  for (const dir of [project, sessions, linkedTarget, linkedRoot, path.join(parentTarget, "project"), parentRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(linkedTarget, "private.txt"), "REJECTED_ROOT_MARKER");
  writeFileSync(path.join(parentTarget, "project", "private.txt"), "REJECTED_ROOT_MARKER");
  const sessionPath = path.join(sessions, "one.jsonl");
  const projectFile = path.join(project, "notes.txt");
  const jsonl = (text) => [JSON.stringify({ type: "session", id: "s1", cwd: project, timestamp: "2026-10-21T00:00:00Z" }), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: text } })].join("\n") + "\n";
  writeFileSync(sessionPath, jsonl("STALE_MARKER original ЕВРОПА Über"));
  writeFileSync(projectFile, "PROJECT_MARKER first version\n");
  writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [project, linkedRoot, parentRoot].map((filePath) => ({ path: filePath, addedAt: "2026-10-21T00:00:00Z", hidden: false })) }));
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText, readSearchPreview } = await jiti.import("./full-text-search.ts");
    const { indexStatus } = await jiti.import("./search-index.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    allowFileRoot(project);

    // SQLite's lower() folds ASCII only; a Unicode needle must not be filtered
    // out before the JavaScript regex sees the row.
    const building = searchFullText("европа");
    assert.equal(indexStatus().phase, "building");
    assert.equal((await building).results.length, 1);
    assert.equal(indexStatus().phase, "idle");
    const refreshing = searchFullText("über");
    assert.equal(indexStatus().phase, "refreshing");
    assert.equal((await refreshing).results.length, 1);
    assert.equal(indexStatus().phase, "idle");
    assert.equal((await searchFullText("ЕВРОПА")).results.length, 1);

    // Managed roots can be replaced after their canonical paths were cached.
    rmSync(linkedRoot, { recursive: true });
    symlinkSync(linkedTarget, linkedRoot, "dir");
    rmSync(linkedParent, { recursive: true });
    symlinkSync(parentTarget, linkedParent, "dir");

    const rejected = await searchFullText("REJECTED_ROOT_MARKER");
    assert.equal(rejected.results.length, 0, "neither a symlink root nor a symlink ancestor may be traversed");
    assert.equal(rejected.warningCount, 2);
    assert.ok(rejected.warnings.some((warning) => warning.includes(linkedRoot) && /symbolic/.test(warning)));
    assert.ok(rejected.warnings.some((warning) => warning.includes(parentRoot) && /symbolic/.test(warning)));

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

    // The explicit refresh also follows project content changes.
    writeFileSync(projectFile, "PROJECT_MARKER second version\n");
    const { ensureProjectRefresh } = await jiti.import("./search-index.ts");
    await ensureProjectRefresh();
    const projectHits = (await searchFullText("PROJECT_MARKER")).results;
    assert.equal(projectHits.length, 1);
    assert.match((await readSearchPreview(projectHits[0].source, projectHits[0].section, projectHits[0].offset)).text, /second version/);

    writeFileSync(projectFile, Buffer.from("PROJECT_MARKER\0now binary"));
    await ensureProjectRefresh();
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 0, "binary replacement removes searchable text");
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 0, "an unchanged binary source cannot revive stale text");

    writeFileSync(projectFile, "RESTORED_PROJECT_MARKER readable again\n");
    assert.equal((await searchFullText("RESTORED_PROJECT_MARKER")).results.length, 1, "a binary source can become text again");
    rmSync(projectFile);
    assert.equal((await searchFullText("RESTORED_PROJECT_MARKER")).results.length, 0, "deleted project files leave the index");

    rmSync(sessionPath);
    assert.equal((await searchFullText("FRESH_MARKER")).results.length, 0, "deleted transcripts leave the index");
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
