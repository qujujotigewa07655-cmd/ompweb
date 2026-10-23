import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const worker = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));

function runWorker(t, { kind = "omp", metadata = { name: "@kahme247/ompweb", private: true }, go = true, mode = "success", disabled = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ompweb-worker-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attempt = randomUUID();
  const invoked = join(root, "invoked");
  const binary = join(root, "fake-omp");
  writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, JSON.stringify(process.argv.slice(2)));\n${mode === "nonzero" ? "process.exit(23)" : mode === "signal" ? "process.kill(process.pid, 'SIGTERM')" : mode === "timeout" ? "setInterval(() => {}, 1000)" : "process.exit(0)"}\n`, { mode: 0o700 });
  // Keep the production timeout/error handling, but shorten only the external
  // binary's deadline so the real timeout regression does not take five minutes.
  const preload = join(root, "deadline.cjs");
  writeFileSync(preload, `const cp = require('node:child_process'); const spawn = cp.spawnSync; cp.spawnSync = (bin, args, options) => spawn(bin === ${JSON.stringify(binary)} ? process.execPath : bin, bin === ${JSON.stringify(binary)} ? [bin, ...args] : args, { ...options, timeout: ${mode === "timeout" ? 500 : 10000} });`);
  if (metadata !== undefined) writeFileSync(join(root, "package.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  writeFileSync(join(root, "status.json"), JSON.stringify({ attemptId: attempt, state: "prepared" }));
  if (go) writeFileSync(join(root, `${attempt}.go`), "{}");
  const result = spawnSync(process.execPath, ["--require", preload, worker,
    "--attempt", attempt, "--root", root, "--package-dir", root,
    "--kind", kind, "--target", "999.0.0", "--launcher-pid", "0", "--server-pid", "0",
    "--manager-path", binary,
  ], { timeout: 15000, encoding: "utf8", env: {
    ...process.env, HOME: root, USERPROFILE: root,
    OMP_WEB_DISABLE_AUTOUPDATE: disabled ? "1" : "0",
    OMP_WEB_OMP_BIN: mode === "missing" ? join(root, "missing") : binary,
  } });
  assert.ifError(result.error);
  const status = JSON.parse(readFileSync(join(root, "status.json"), "utf8"));
  return { status, invoked: existsSync(invoked), complete: existsSync(join(root, `${attempt}.complete.json`)) };
}

test("OMP worker succeeds on exit zero even for a private app package", (t) => {
  const result = runWorker(t);
  assert.equal(result.status.state, "succeeded");
  assert.equal(result.invoked, true);
  assert.equal(result.complete, true);
});

for (const mode of ["nonzero", "missing", "signal", "timeout"]) {
  test(`OMP worker reports ${mode} as failure, never completion`, (t) => {
    const result = runWorker(t, { mode });
    assert.equal(result.status.state, "failed");
    assert.match(result.status.error, /OMP update failed/);
    assert.equal(result.complete, false);
  });
}

test("worker requires GO before invoking the update binary", (t) => {
  const result = runWorker(t, { go: false });
  assert.equal(result.status.state, "failed");
  assert.match(result.status.error, /commit signal/);
  assert.equal(result.invoked, false);
  assert.equal(result.complete, false);
});

test("direct worker honors the global opt-out for OMP", (t) => {
  const result = runWorker(t, { disabled: true });
  assert.equal(result.status.state, "failed");
  assert.match(result.status.error, /Updates are disabled/);
  assert.equal(result.invoked, false);
});

for (const metadata of [{ name: "@kahme247/ompweb", private: true }, { name: "fork" }, "{", "null", { name: "@kahme247/ompweb", private: "false" }]) {
  test(`direct app worker rejects unsupported metadata ${JSON.stringify(metadata)} before stopping/installing`, (t) => {
    const result = runWorker(t, { kind: "app", metadata });
    assert.equal(result.status.state, "failed");
    assert.match(result.status.error, /private or non-upstream/);
    assert.equal(result.status.stage, undefined);
    assert.equal(result.invoked, false);
    assert.equal(result.complete, false);
  });
}
