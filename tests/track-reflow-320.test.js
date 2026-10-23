#!/usr/bin/env node
// /track/ at 320px: the one-column grid must be minmax(0, 1fr). Plain "1fr"
// lets the column grow to its content's min width (298px inside 272px),
// which made the page scroll sideways by 2px. Browser check: npm run e2e.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "frontend/track/index.html"), "utf8");
const m = /@media \(max-width: 900px\) \{ \.track-layout \{ grid-template-columns: ([^;]+); \} \}/.exec(html);
assert.ok(m, "mobile track-layout rule present");
assert.strictEqual(m[1].trim(), "minmax(0, 1fr)");
console.log("ok - /track/ mobile grid column can shrink to the viewport (minmax(0, 1fr))");
console.log("1/1 passed");
