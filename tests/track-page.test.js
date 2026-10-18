// Static checks for the /track/ page mobile fixes (no DOM runner in CI;
// behaviour is covered by the Playwright mobile smoke run locally).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "frontend", "track");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "track.js"), "utf8");
let failed = 0;
function test(name, fn) {
  try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); }
}

test("lookup inputs use >=16px text so iOS Safari doesn't zoom on focus", () => {
  const m = html.match(/\.lookup-form input, \.lookup-form button \{([^}]*)\}/);
  assert(m, "lookup-form input rule missing");
  const fs_ = m[1].match(/font-size:\s*([\d.]+)(rem|px)/);
  assert(fs_, "font-size missing");
  const px = fs_[2] === "rem" ? parseFloat(fs_[1]) * 16 : parseFloat(fs_[1]);
  assert(px >= 16, "font-size " + px + "px < 16px");
  const mh = m[1].match(/min-height:\s*(\d+)px/);
  assert(mh && +mh[1] >= 44, "tap target min-height >= 44px");
});

test("lookup inputs have real labels", () => {
  assert(/<label for="lookupOrderNum">/.test(html), "order number label");
  assert(/<label for="lookupPhone">/.test(html), "phone label");
  assert(/id="lookupPhone"[^>]*autocomplete="tel"/.test(html), "phone autocomplete=tel");
});

test("errors are inline and announced, not alert() pop-ups", () => {
  assert(/id="lookupMessage"[^>]*role="status"[^>]*aria-live="polite"/.test(html), "inline live region");
  const calls = js.split("\n").filter((l) => /\balert\(/.test(l) && !/if \(!box\)/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(calls, [], "unexpected alert() calls");
});

test("timeline dots have visible labels", () => {
  ["Order received", "Driver assigned", "On the way", "Completed"].forEach((t) =>
    assert(html.includes("</div>" + t + "</div>"), "missing timeline label " + t));
  assert(/\.timeline-dot\.active\s*\{/.test(html), "active dot style");
});

test("driver card doesn't say 'Not assigned yet' for an assigned order", () => {
  assert(/hasDriver = !!order\.driver_id \|\| order\.status === "assigned"/.test(js), "assigned-driver text");
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("track-page tests passed");
