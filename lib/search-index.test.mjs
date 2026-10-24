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
    const { indexStatus, searchDatabase } = await jiti.import("./search-index.ts");
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

    // A search refreshes messages only; the project walk is the background
    // pass. Run it explicitly here so the project assertions below see files.
    const { ensureProjectRefresh } = await jiti.import("./search-index.ts");
    await ensureProjectRefresh();
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 1, "project files are indexed by the background pass");

    // An unchanged source must be re-extracted, not retain v6's stale chunks.
    const oldIndex = searchDatabase();
    oldIndex.prepare("UPDATE sections SET text = 'CORRUPTED_EXTRACTION' WHERE kind = 'file'").run();
    oldIndex.exec("PRAGMA user_version = 6");
    oldIndex.close();
    delete globalThis.__ompSearchIndex;
    await ensureProjectRefresh();
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 1, "version 6 caches must re-extract unchanged files");
    assert.equal((await searchFullText("CORRUPTED_EXTRACTION")).results.length, 0, "stale extraction must be discarded");

    // Managed roots can be replaced after their canonical paths were cached.
    rmSync(linkedRoot, { recursive: true });
    symlinkSync(linkedTarget, linkedRoot, "dir");
    rmSync(linkedParent, { recursive: true });
    symlinkSync(parentTarget, linkedParent, "dir");

    const rejected = await searchFullText("REJECTED_ROOT_MARKER");
    const projectPass = await ensureProjectRefresh();
    assert.equal(rejected.results.length, 0, "neither a symlink root nor a symlink ancestor may be traversed");
    assert.equal(projectPass.warningCount, 2, projectPass.warnings.join("\n"));
    assert.ok(projectPass.warnings.some((warning) => warning.includes(linkedRoot) && /symbolic/.test(warning)));
    assert.ok(projectPass.warnings.some((warning) => warning.includes(parentRoot) && /symbolic/.test(warning)));

    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 1);
    assert.equal((await searchFullText("FRESH_MARKER")).results.length, 0);

    writeFileSync(sessionPath, jsonl("FRESH_MARKER rewritten"));
    const fresh = await searchFullText("FRESH_MARKER");
    assert.equal(fresh.results.length, 1, "edited transcripts are reindexed by a search");
    assert.equal((await searchFullText("STALE_MARKER")).results.length, 0, "replaced text is dropped from the index");

    const added = path.join(sessions, "two.jsonl");
    writeFileSync(added, jsonl("ADDED_MARKER new session"));
    assert.equal((await searchFullText("ADDED_MARKER")).results.length, 1, "new transcripts are indexed by a search");

    rmSync(added);
    assert.equal((await searchFullText("ADDED_MARKER")).results.length, 0, "deleted transcripts leave the index");

    // The explicit refresh also follows project content changes.
    writeFileSync(projectFile, "PROJECT_MARKER second version\n");
    await ensureProjectRefresh();
    const projectHits = (await searchFullText("PROJECT_MARKER")).results;
    assert.equal(projectHits.length, 1);
    assert.match((await readSearchPreview(projectHits[0].source, projectHits[0].section, projectHits[0].offset)).text, /second version/);

    writeFileSync(projectFile, Buffer.from("PROJECT_MARKER\0now binary"));
    await ensureProjectRefresh();
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 0, "binary replacement removes searchable text");
    assert.equal((await searchFullText("PROJECT_MARKER")).results.length, 0, "an unchanged binary source cannot revive stale text");

    writeFileSync(projectFile, "RESTORED_PROJECT_MARKER readable again\n");
    await ensureProjectRefresh();
    assert.equal((await searchFullText("RESTORED_PROJECT_MARKER")).results.length, 1, "a binary source can become text again");
    rmSync(projectFile);
    await ensureProjectRefresh();
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

// A search must still see a transcript written a moment ago, but it must not
// walk the project trees: those are tens of thousands of paths, refreshed in
// the background. Searches that arrive together share one message pass.
test("concurrent searches refresh messages only and share one pass", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".search-index-concurrent-"));
  const agent = path.join(root, "agent-state");
  const project = path.join(root, "project");
  const sessions = path.join(agent, "sessions", "workspace");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  process.env.GIT_CEILING_DIRECTORIES = root;
  for (const dir of [project, sessions]) mkdirSync(dir, { recursive: true });
  const projectFile = path.join(project, "notes.txt");
  const sessionPath = path.join(sessions, "chat.jsonl");
  const jsonl = (text) => [JSON.stringify({ type: "session", id: "s1", cwd: project, timestamp: "2026-10-21T00:00:00Z" }), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: text } })].join("\n") + "\n";
  writeFileSync(projectFile, "FIRST_MARKER\n");
  writeFileSync(sessionPath, jsonl("FIRST_MARKER from transcript"));
  writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, addedAt: "2026-10-21T00:00:00Z", hidden: false }] }));
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText } = await jiti.import("./full-text-search.ts");
    const { indexStatus, ensureProjectRefresh } = await jiti.import("./search-index.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    allowFileRoot(project);

    // The project file is found by the background pass, not by a search.
    await ensureProjectRefresh();
    assert.equal((await searchFullText("FIRST_MARKER")).results.length, 2, "transcript and project file are both indexed");
    // `version` advances exactly once per index pass, so it counts the walks.
    const before = indexStatus().version;
    const burst = await Promise.all(Array.from({ length: 5 }, () => searchFullText("FIRST_MARKER")));
    assert.deepEqual(burst.map((page) => page.results.length), [2, 2, 2, 2, 2]);
    // A search that arrives mid-walk cannot trust that walk (the file it cares
    // about may already have been statted), so it waits and shares ONE follow-up
    // pass. Bursts therefore cost at most two walks — never one per search.
    const walks = indexStatus().version - before;
    assert.ok(walks <= 2, `five concurrent searches must not queue five walks (got ${walks})`);

    const beforeMore = indexStatus().version;
    await Promise.all(Array.from({ length: 20 }, () => searchFullText("FIRST_MARKER")));
    const walksForTwenty = indexStatus().version - beforeMore;
    assert.ok(walksForTwenty <= 2, `walk count must not grow with the burst (got ${walksForTwenty} for 20)`);

    // The message freshness promise stays: a transcript written a moment ago is
    // found by the very next search, with no background pass involved.
    writeFileSync(sessionPath, jsonl("SECOND_MARKER fresh transcript"));
    assert.equal((await searchFullText("SECOND_MARKER")).results.length, 1, "a just-written transcript must still be found");
    assert.equal((await searchFullText("FIRST_MARKER")).results.length, 1, "only the project file keeps the old marker");

    // A project edit waits for the background pass instead of blocking a search.
    writeFileSync(projectFile, "THIRD_MARKER project\n");
    assert.equal((await searchFullText("THIRD_MARKER")).results.length, 0, "a search does not walk project trees");
    await ensureProjectRefresh();
    assert.equal((await searchFullText("THIRD_MARKER")).results.length, 1, "the background pass picks the edit up");
  } finally {
    clearInterval(globalThis.__ompSearchIndexTimer);
    await globalThis.__ompSearchIndexPass;
    await globalThis.__ompSearchIndexQueued;
    await globalThis.__ompSearchIndexWrite;
    globalThis.__ompSearchIndex?.close();
    for (const key of Object.keys(globalThis)) if (key.startsWith("__ompSearchIndex")) delete globalThis[key];
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = oldCache;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

// The project walk is the only thing keeping project results fresh, and it also
// decides which stored rows are still real. Neither is observable through a
// search, so both invariants are asserted here: a directory a walk could not
// read must not lose its rows, and the refresh timer must actually run the
// project pass rather than a messages-only one.
test("a failed walk keeps its rows and the refresh timer walks projects", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".search-index-timer-"));
  const agent = path.join(root, "agent-state");
  const project = path.join(root, "project");
  const unreadable = path.join(project, "unreadable");
  const sessions = path.join(agent, "sessions", "workspace");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  process.env.GIT_CEILING_DIRECTORIES = root;
  for (const dir of [project, unreadable, sessions]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(project, "kept.txt"), "KEPT_MARKER\n");
  writeFileSync(path.join(unreadable, "hidden.txt"), "UNREACHABLE_MARKER\n");
  writeFileSync(path.join(sessions, "chat.jsonl"), [JSON.stringify({ type: "session", id: "s1", cwd: project, timestamp: "2026-10-21T00:00:00Z" }), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "TRANSCRIPT_MARKER" } })].join("\n") + "\n");
  writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, addedAt: "2026-10-21T00:00:00Z", hidden: false }] }));
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText } = await jiti.import("./full-text-search.ts");
    const { ensureProjectRefresh, indexStatus } = await jiti.import("./search-index.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    const fsPromises = (await import("node:fs")).promises;
    allowFileRoot(project);
    await ensureProjectRefresh();
    assert.equal((await searchFullText("UNREACHABLE_MARKER")).results.length, 1);

    // A walk that cannot open a directory proves nothing about its files: the
    // rows must survive, or a temporary permission problem silently wipes them.
    const opened = fsPromises.opendir;
    fsPromises.opendir = async (dir, ...rest) => {
      if (path.resolve(String(dir)) === unreadable) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return opened(dir, ...rest);
    };
    const denied = await ensureProjectRefresh();
    fsPromises.opendir = opened;
    // Other roots in this process may legitimately warn; only this directory matters.
    assert.ok(denied.warnings.some((warning) => warning.includes(unreadable)), denied.warnings.join("\n"));
    assert.equal((await searchFullText("UNREACHABLE_MARKER")).results.length, 1, "an unreadable directory must not delete its indexed files");

    // A file that is really gone still leaves the index.
    rmSync(path.join(project, "kept.txt"));
    await ensureProjectRefresh();
    assert.equal((await searchFullText("KEPT_MARKER")).results.length, 0, "a deleted project file leaves the index");

    // The interval handler is the only steady-state refresher now: drive it and
    // check that it takes a project edit, which a messages-only pass cannot.
    writeFileSync(path.join(project, "added.txt"), "TIMER_MARKER\n");
    assert.equal((await searchFullText("TIMER_MARKER")).results.length, 0, "a search does not walk project trees");
    const timer = globalThis.__ompSearchIndexTimer;
    assert.ok(timer, "the refresh timer is armed");
    const beforeProjectsAt = indexStatus().projectsAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Fire the same callback the interval holds, without waiting five minutes.
    timer._onTimeout();
    await globalThis.__ompSearchIndexPass;
    assert.ok(indexStatus().projectsAt >= beforeProjectsAt, "the timer's pass stamps the project walk");
    assert.equal((await searchFullText("TIMER_MARKER")).results.length, 1, "the timer's project pass indexes project files");
  } finally {
    clearInterval(globalThis.__ompSearchIndexTimer);
    await globalThis.__ompSearchIndexPass;
    await globalThis.__ompSearchIndexQueued;
    await globalThis.__ompSearchIndexWrite;
    globalThis.__ompSearchIndex?.close();
    for (const key of Object.keys(globalThis)) if (key.startsWith("__ompSearchIndex")) delete globalThis[key];
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = oldCache;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

// A project added while the server runs has nothing in the index, and the timer
// may not reach it for minutes. The user searches precisely then, so the next
// search must walk the new root instead of reporting a complete negative.
test("a project added after boot is searchable on the next search", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".search-index-newroot-"));
  const agent = path.join(root, "agent-state");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const sessions = path.join(agent, "sessions", "workspace");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldCache = process.env.JITI_FS_CACHE;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.JITI_FS_CACHE = "0";
  process.env.GIT_CEILING_DIRECTORIES = root;
  for (const dir of [first, second, sessions]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(first, "a.txt"), "FIRST_PROJECT_MARKER\n");
  writeFileSync(path.join(second, "b.txt"), "SECOND_PROJECT_MARKER\n");
  writeFileSync(path.join(sessions, "chat.jsonl"), [JSON.stringify({ type: "session", id: "s1", cwd: first, timestamp: "2026-10-21T00:00:00Z" }), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "TRANSCRIPT_MARKER" } })].join("\n") + "\n");
  const registry = (paths) => writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: paths.map((project) => ({ path: project, addedAt: "2026-10-21T00:00:00Z", hidden: false })) }));
  registry([first]);
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
    const { searchFullText } = await jiti.import("./full-text-search.ts");
    const { ensureProjectRefresh } = await jiti.import("./search-index.ts");
    const { allowFileRoot } = await jiti.import("./file-access.ts");
    allowFileRoot(first);
    allowFileRoot(second);
    await ensureProjectRefresh();
    assert.equal((await searchFullText("FIRST_PROJECT_MARKER")).results.length, 1);

    // Add the second project the way the UI does, then search it right away.
    registry([first, second]);
    globalThis.__ompSearchIndexRoots = undefined;
    assert.equal((await searchFullText("SECOND_PROJECT_MARKER")).results.length, 1, "the next search walks a newly added project");
  } finally {
    clearInterval(globalThis.__ompSearchIndexTimer);
    await globalThis.__ompSearchIndexPass;
    await globalThis.__ompSearchIndexQueued;
    await globalThis.__ompSearchIndexWrite;
    globalThis.__ompSearchIndex?.close();
    for (const key of Object.keys(globalThis)) if (key.startsWith("__ompSearchIndex")) delete globalThis[key];
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldCache === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = oldCache;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});
