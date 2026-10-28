#!/usr/bin/env node
// Home page must expose a single <main> landmark so assistive tech can skip
// the nav (axe landmark-one-main / region).
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "frontend/index.html"), "utf8");
const mains = html.match(/<main\b[^>]*>/g) || [];
const closes = html.match(/<\/main>/g) || [];
const openAt = html.indexOf("<main");
const closeAt = html.indexOf("</main>");
const navAt = html.indexOf("</nav>");
const footAt = html.indexOf('<footer class="footer">');
const tests = [
  ["exactly one <main>", mains.length === 1],
  ["exactly one </main>", closes.length === 1],
  ["<main> comes after </nav>", openAt > navAt && navAt >= 0],
  ["</main> comes before footer.footer", closeAt > openAt && closeAt < footAt && footAt >= 0],
];
let pass = 0;
for (const [name, ok] of tests) { console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
