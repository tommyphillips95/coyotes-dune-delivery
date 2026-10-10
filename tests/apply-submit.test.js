#!/usr/bin/env node
/**
 * Driver application submit (lost-applications fix).
 * The page may only show "submitted" when the server confirmed the save.
 * Every failure shows the honest message and keeps the form as typed.
 * SSN / bank numbers never go to localStorage.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const S = require(path.join(ROOT, "frontend/js/apply-submit.js"));

const MSG = "We couldn't submit your application right now. Please try again later or contact us.";
const res = (status, body, opts) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (opts && opts.badJson) throw new SyntaxError("Unexpected token <"); return body; },
});

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("message text is exactly the approved wording", () => {
  assert.strictEqual(S.SUBMIT_ERROR_MESSAGE, MSG);
});

test("confirmed save → ok with the server's applicationId", async () => {
  const r = await S.sendApplication(async () => res(201, { success: true, applicationId: "a1b2" }), "/api/applications", {});
  assert.deepStrictEqual(r, { ok: true, applicationId: "a1b2" });
  const n = await S.sendApplication(async () => res(200, { applicationId: 42 }), "/x", {});
  assert.deepStrictEqual(n, { ok: true, applicationId: "42" });
});

test("404 (today's production response) is a failure", async () => {
  assert.deepStrictEqual(await S.sendApplication(async () => res(404, {}), "/api/applications", {}), { ok: false, reason: "http_404" });
});

test("500 / 502 are failures", async () => {
  for (const code of [500, 502]) {
    assert.strictEqual((await S.sendApplication(async () => res(code, { error: "x" }), "/x", {})).ok, false);
  }
});

test("network error is a failure, never a throw", async () => {
  const r = await S.sendApplication(async () => { throw new TypeError("Failed to fetch"); }, "/x", {});
  assert.deepStrictEqual(r, { ok: false, reason: "network" });
});

test("2xx without JSON (e.g. an HTML page) is a failure", async () => {
  assert.deepStrictEqual(await S.sendApplication(async () => res(200, null, { badJson: true }), "/x", {}), { ok: false, reason: "bad_json" });
});

test("2xx without an applicationId is a failure", async () => {
  for (const body of [{}, { success: true }, { applicationId: "" }, { applicationId: "  " }, null]) {
    assert.deepStrictEqual(await S.sendApplication(async () => res(200, body), "/x", {}), { ok: false, reason: "no_application_id" });
  }
});

test("sensitive fields are stripped before localStorage", () => {
  const out = S.stripSensitive({ firstName: "Ana", ssn: "123-45-6789", accountNumber: "1", confirmAccountNumber: "1", routingNumber: "111000025", city: "Port A" });
  assert.deepStrictEqual(out, { firstName: "Ana", city: "Port A" });
});

test("apply.js: no fake success path, success only after a confirmed save", () => {
  const src = read("frontend/js/apply.js");
  assert.ok(!/generateAppId/.test(src), "no client-generated application IDs");
  assert.ok(!/show success with generated ID anyway/i.test(src));
  assert.ok(/sendApplication\(/.test(src));
  const submit = src.slice(src.indexOf("async function submitApplication"), src.indexOf("function showSubmitError"));
  const failIdx = submit.indexOf("if (!result.ok)");
  const successIdx = submit.indexOf("showSuccess(");
  assert.ok(failIdx > -1 && successIdx > failIdx, "failure is handled before showSuccess");
  const failBlock = submit.slice(failIdx, submit.indexOf("return;", failIdx));
  assert.ok(/showSubmitError\(\)/.test(failBlock) && !/clearSavedData|showSuccess|reset\(/.test(failBlock), "failure keeps data");
  const catchBlock = submit.slice(submit.indexOf("} catch (err) {"), submit.indexOf("} finally {"));
  assert.ok(/showSubmitError\(\)/.test(catchBlock) && !/showSuccess|clearSavedData/.test(catchBlock), "catch is honest too");
  assert.strictEqual((submit.match(/clearSavedData\(\)/g) || []).length, 1);
  assert.ok(/stripSensitive\(data\)/.test(src), "saveFormData strips sensitive fields");
});

test("apply page has the alert slot and loads the helper first", () => {
  const html = read("frontend/apply/index.html");
  assert.ok(/id="submitError"[^>]*role="alert"[^>]*hidden/.test(html));
  const h = html.indexOf("js/apply-submit.js"), a = html.indexOf("js/apply.js");
  assert.ok(h > -1 && a > h);
});

test("no plain-text SSN/bank storage was added server side", () => {
  // The form still posts to the documented gap (/api/applications); it was
  // NOT pointed at submit-application, which stores ssn/bank columns as text.
  const src = read("frontend/js/apply.js");
  assert.ok(!/submit-application/.test(src));
});

(async () => {
  let failed = 0;
  console.log("apply-submit.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); } catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + e.message); }
  }
  if (failed) { console.error(`apply-submit: ${failed} failed`); process.exit(1); }
  console.log(`apply-submit: ${tests.length} passed`);
})();
