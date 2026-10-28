#!/usr/bin/env node
// Runs every tests/*.test.js in its own node process, one after another,
// so new test files don't need an edit to the `npm test` line.
// Exits non-zero if any file fails (or if no test files are found).
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
if (!files.length) { console.error("run-all: no tests/*.test.js files found"); process.exit(1); }

const failed = [];
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit", cwd: path.join(dir, "..") });
  if (r.status !== 0) failed.push(`${f} (${r.signal ? "signal " + r.signal : "exit " + r.status})`);
}
console.log(`\nrun-all: ${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) { console.error("FAILED:\n  " + failed.join("\n  ")); process.exit(1); }
