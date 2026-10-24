/* The real support line is (361) 897-9670; the old 555-1234 placeholder must not ship anywhere. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
const files = execSync("git ls-files", { cwd: root }).toString().split("\n").filter((f) => f && !/^tests\/support-phone\.test\.js$/.test(f) && /\.(html|js|mjs|json|md|toml|txt|xml|webmanifest)$/.test(f));
const OLD = /(\+?1[-. ]?)?\(?361\)?[-. ]?555[-. ]?1234/;
let failed = 0;
const t = (n, f) => { try { f(); } catch (e) { failed++; console.error("FAIL", n, e.message); } };
t("no 555-1234 variant in any tracked file", () => {
  const hits = files.filter((f) => OLD.test(fs.readFileSync(path.join(root, f), "utf8")));
  assert.deepStrictEqual(hits, []);
});
t("footers link the real number", () => {
  for (const f of ["frontend/index.html", "frontend/order/index.html"]) assert.ok(fs.readFileSync(path.join(root, f), "utf8").includes('<a href="tel:+13618979670">(361) 897-9670</a>'), f);
});
t("order error and chat replies use the real number", () => {
  for (const f of ["frontend/js/coastal.js", "frontend/js/order.js", "frontend/js/main.js"]) assert.ok(fs.readFileSync(path.join(root, f), "utf8").includes("(361) 897-9670"), f);
});
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("support-phone: 3 passed");
