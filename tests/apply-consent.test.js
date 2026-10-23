#!/usr/bin/env node
/**
 * Driver application consent (5-step form).
 * Before: submit ran validateStep(6) on a 5-step form (no inputs → always
 * valid), so the final confirm/terms box was never checked and the review
 * summary (built only when moving to "step 6") stayed empty. The server
 * accepted applications with no consents at all.
 * Browser side: the real apply.js functions run against a small fake DOM built
 * from the real form's steps and fields. Server side: submit-application with
 * Supabase faked. No network, no browser.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio" || request === "stripe") throw new Error(request + " must not load in tests");
  return realLoad.apply(this, arguments);
};
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HTML = read("frontend/apply/index.html");
const JS = read("frontend/js/apply.js");
const submit = require(path.join(ROOT, "netlify/functions/submit-application.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const CONSENTS = ["bgConsent", "bgDisclosureRead", "esignature", "termsAgree"];

// ── Real form structure from the HTML ─────────────────────────────────────
const attrs = (tag) => { const a = {}; tag.replace(/([\w-]+)(?:="([^"]*)")?/g, (_, k, v) => { a[k] = v === undefined ? "" : v; }); return a; };
function formSteps() {
  const steps = {};
  const re = /<div class="form-step[^"]*" data-step="(\d+)">/g; let m; const starts = [];
  while ((m = re.exec(HTML))) starts.push({ n: +m[1], at: m.index });
  starts.forEach((s, i) => {
    const chunk = HTML.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : HTML.indexOf("</form>", s.at));
    steps[s.n] = [...chunk.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((x) => {
      const a = attrs(x[0].slice(x[1].length + 1));
      return { tag: x[1], name: a.name || a.id, id: a.id, type: x[1] === "input" ? (a.type || "text") : x[1], required: "required" in a };
    }).filter((f) => f.name && !/^(hidden|submit|button)$/.test(f.type));
  });
  return steps;
}

// ── Tiny fake DOM ─────────────────────────────────────────────────────────
function makeDom() {
  const doc = { activeElement: null, byId: {} };
  class El {
    constructor(tag, opts = {}) {
      Object.assign(this, { tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, value: "", checked: false, type: "", required: false, textContent: "", innerHTML: "", dataset: {} }, opts);
      const set = new Set(opts.cls || []); this._cls = set;
      this.classList = { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c) };
      this.id = opts.id || ""; if (this.id) doc.byId[this.id] = this;
    }
    add(...kids) { kids.forEach((k) => { k.parent = this; this.children.push(k); }); return this; }
    matches(sel) { return sel.startsWith(".") ? this._cls.has(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
    closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parent; } return null; }
    querySelector(sel) { for (const k of this.children) { if (k.matches(sel)) return k; const f = k.querySelector(sel); if (f) return f; } return null; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { doc.activeElement = this; }
    scrollIntoView() {}
  }
  return { doc, El };
}

function fnSrc(name) {
  const i = JS.indexOf(`function ${name}(`);
  assert.ok(i >= 0, "apply.js has " + name);
  let d = 0, j = JS.indexOf("{", i);
  for (; j < JS.length; j++) { if (JS[j] === "{") d++; else if (JS[j] === "}" && --d === 0) break; }
  const start = JS.lastIndexOf("async ", i) === i - 6 ? i - 6 : i;
  return JS.slice(start, j + 1) + "\n";
}
function constSrc(name) {
  const i = JS.indexOf(`const ${name} =`);
  if (i < 0) return "";
  let d = 0, j = JS.indexOf("{", i);
  for (; j < JS.length; j++) { if (JS[j] === "{") d++; else if (JS[j] === "}" && --d === 0) break; }
  return JS.slice(i, j + 2).replace(/^const /, "var ") + "\n";
}

/** Fake page: every step and field of the real form, text fields filled, all consents ticked. */
function page() {
  const { doc, El } = makeDom();
  const steps = formSteps();
  const stepEls = {}; const all = [];
  for (const n of Object.keys(steps)) {
    const stepEl = new El("div", { cls: ["form-step"], dataset: { step: n } });
    for (const f of steps[n]) {
      const input = new El(f.tag, { id: f.id || "", name: f.name, type: f.type, required: f.required && f.type !== "file" && f.type !== "checkbox" ? false : f.required });
      if (f.type === "checkbox") input.checked = true;
      else input.value = f.type === "file" ? "C:\\fakepath\\card.jpg" : "x";
      const err = new El("span", { cls: ["error-message"], id: f.id ? f.id + "Error" : "" });
      stepEl.add(new El("div", { cls: [f.type === "checkbox" ? "checkbox-group" : "form-group"] }).add(input, err));
      all.push(input);
    }
    stepEls[n] = stepEl;
  }
  const byName = (n) => all.find((i) => i.name === n);
  const summaryBody = new El("tbody", { id: "summaryBody" });
  const sent = [];
  const ctx = {
    console, Array, String, parseInt, Date, FormData: class { constructor() { this.m = []; } append(k, v) { this.m.push([k, v]); } forEach(cb) { this.m.forEach(([k, v]) => cb(v, k)); } },
    document: {
      querySelector: (sel) => { const m = /data-step="(\d+)"/.exec(sel); if (m) return stepEls[m[1]] || null; const n = /\[name="([^"]+)"\]/.exec(sel); if (n) return byName(n[1]) || null; return null; },
      querySelectorAll: (sel) => sel === ".form-step" ? Object.values(stepEls) : sel.startsWith(".form-step input") ? all : [],
      getElementById: (id) => doc.byId[id] || null,
    },
    get activeElement() { return doc.activeElement; },
    window: { CoyoteApplySubmit: { sendApplication: async (f, url, opts) => { sent.push(opts); return { ok: true, applicationId: "a1" }; } } },
    fetch: () => {}, uploadedFiles: { insuranceCard: { name: "<b>card</b>.jpg" } },
    insuranceInput: byName("insuranceCard"), insuranceError: doc.byId.insuranceError || new El("span", { cls: ["error-message"] }),
    INSURANCE_REQUIRED_MSG: "Please upload your insurance card.",
    summaryBody, submitBtn: new El("button"), isSubmitting: false, currentStep: 1,
    hideSubmitError() {}, showSubmitError() {}, showSuccess() {}, clearSavedData() {},
  };
  ctx.getStepEl = (n) => stepEls[n] || null;
  ctx.getStepInputEls = (n) => (stepEls[n] ? all.filter((i) => { let e = i; while (e) { if (e === stepEls[n]) return true; e = e.parent; } return false; }) : []);
  ctx.$$$ = (s) => ctx.document.querySelectorAll(s);
  vm.createContext(ctx);
  const tm = /const TOTAL_STEPS = (\d+);/.exec(JS);
  vm.runInContext("var TOTAL_STEPS = " + tm[1] + ";\n" + constSrc("validators") + constSrc("LABEL_MAP") +
    ["linkError", "focusField", "validateField", "validateStep", "validateAllSteps", "showStep", "escapeHtml", "buildSummary", "submitApplication"].filter((n) => JS.includes(`function ${n}(`)).map(fnSrc).join(""), ctx);
  return { ctx, doc, byName, stepEls, sent, steps, summaryBody };
}
const evt = { preventDefault() {} };
const linked = (input) => { const e = input.parent.querySelector(".error-message"); return (input.getAttribute("aria-describedby") || "").split(/\s+/).includes(e.id) && e.classList.contains("visible"); };

test("the form really has 5 steps and the consents are where the code expects", () => {
  const steps = formSteps();
  assert.deepStrictEqual(Object.keys(steps).map(Number), [1, 2, 3, 4, 5]);
  assert.ok(/const TOTAL_STEPS = 5;/.test(JS));
  const names = (n) => steps[n].filter((f) => f.type === "checkbox" && f.required).map((f) => f.name);
  assert.deepStrictEqual(names(4), ["bgConsent", "bgDisclosureRead", "esignature"]);
  assert.deepStrictEqual(names(5), ["termsAgree"]);
  assert.deepStrictEqual(submit.REQUIRED_CONSENTS, CONSENTS, "server checks the exact names the form sends");
  assert.ok(!/validateStep\(6\)|=== 6\)/.test(JS), "no hard-coded step 6");
});

test("submit with the final confirm/terms box unticked: blocked, linked error, box focused, nothing sent", async () => {
  const p = page();
  p.ctx.showStep(5);
  p.byName("termsAgree").checked = false;
  await p.ctx.submitApplication(evt);
  assert.strictEqual(p.sent.length, 0, "not sent");
  assert.ok(linked(p.byName("termsAgree")), "visible error linked via aria-describedby");
  assert.strictEqual(p.byName("termsAgree").getAttribute("aria-invalid"), "true");
  assert.strictEqual(p.doc.activeElement, p.byName("termsAgree"));
});

for (const name of ["bgConsent", "bgDisclosureRead", "esignature"]) {
  test(`submit with ${name} (step 4) unticked: back to step 4, linked error, that box focused, nothing sent`, async () => {
    const p = page();
    p.ctx.showStep(5);
    p.byName(name).checked = false;
    await p.ctx.submitApplication(evt);
    assert.strictEqual(p.sent.length, 0);
    assert.strictEqual(p.ctx.currentStep, 4);
    assert.ok(p.stepEls[4].classList.contains("active") && !p.stepEls[5].classList.contains("active"));
    assert.ok(linked(p.byName(name)));
    assert.strictEqual(p.doc.activeElement, p.byName(name));
  });
}

test("first unticked box gets focus when several are missing", async () => {
  const p = page();
  p.ctx.showStep(5);
  p.byName("bgDisclosureRead").checked = false; p.byName("esignature").checked = false; p.byName("termsAgree").checked = false;
  await p.ctx.submitApplication(evt);
  assert.strictEqual(p.doc.activeElement, p.byName("bgDisclosureRead"));
  assert.strictEqual(p.sent.length, 0);
});

test("all consents ticked: submits once, with each consent as 'true'", async () => {
  const p = page();
  p.ctx.showStep(5);
  await p.ctx.submitApplication(evt);
  assert.strictEqual(p.sent.length, 1);
  const body = p.sent[0].body; const vals = {}; body.forEach((v, k) => { vals[k] = v; });
  for (const c of CONSENTS) assert.strictEqual(vals[c], true, c);
});

test("review summary is built on the final step (step 5), escaped", () => {
  const p = page();
  p.byName("firstName").value = "<img src=x onerror=alert(1)>";
  p.ctx.showStep(5);
  assert.ok(/Personal Info/.test(p.summaryBody.innerHTML), "summary filled on step 5");
  assert.ok(!/<img/.test(p.summaryBody.innerHTML) && /&lt;img/.test(p.summaryBody.innerHTML), "values escaped");
  assert.ok(/&lt;b&gt;card&lt;\/b&gt;\.jpg/.test(p.summaryBody.innerHTML), "file name escaped");
});

// ── Server ─────────────────────────────────────────────────────────────────
const quiet = async (f) => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };
const JSON_OK = { firstName: "J", lastName: "S", email: "j@example.com", vehicleClass: "2wd", bgConsent: true, bgDisclosureRead: true, esignature: true, termsAgree: true };
const postJson = (b) => quiet(() => submit.handler({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
async function postMultipart(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  fd.append("insuranceCard", new Blob([jpeg], { type: "image/jpeg" }), "card.jpg");
  const req = new Request("http://x/", { method: "POST", body: fd });
  const buf = Buffer.from(await req.arrayBuffer());
  return quiet(() => submit.handler({ httpMethod: "POST", headers: { "content-type": req.headers.get("content-type") }, body: buf.toString("base64"), isBase64Encoded: true }));
}
const freshFake = () => { fake = createFakeSupabase({ applications: [], documents: [] }); fake.storage = { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }) }) }; };

for (const c of CONSENTS) {
  for (const how of ["missing", "false"]) {
    test(`server JSON: ${c} ${how} → 400 naming it, nothing saved`, async () => {
      freshFake();
      const b = Object.assign({}, JSON_OK);
      if (how === "missing") delete b[c]; else b[c] = false;
      const r = await postJson(b);
      assert.strictEqual(r.statusCode, 400, r.body);
      const body = JSON.parse(r.body);
      assert.strictEqual(body.field, c);
      assert.ok(body.error && body.error.length > 10);
      assert.strictEqual(fake.db.applications.length, 0);
    });
  }
  test(`server multipart: ${c} "false" (unticked box from the browser) → 400, nothing saved`, async () => {
    freshFake();
    const r = await postMultipart(Object.assign({}, JSON_OK, { [c]: "false" }));
    assert.strictEqual(r.statusCode, 400, r.body);
    assert.strictEqual(JSON.parse(r.body).field, c);
    assert.strictEqual(fake.db.applications.length, 0);
  });
}

test("server: all consents → 201 (JSON and multipart); background_check_consent still stored", async () => {
  freshFake();
  const j = await postJson(JSON_OK);
  assert.strictEqual(j.statusCode, 201, j.body);
  const m = await postMultipart(JSON_OK);
  assert.strictEqual(m.statusCode, 201, m.body);
  assert.strictEqual(fake.db.applications.length, 2);
  fake.db.applications.forEach((row) => assert.strictEqual(row.background_check_consent, true));
});

(async () => {
  console.log("apply-consent.test.js");
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok - " + name); }
    catch (e) { failed++; console.log("not ok - " + name); console.log("  " + (e && e.stack || e)); }
  }
  if (failed) { console.error(`apply-consent: ${failed} failed`); process.exit(1); }
  console.log(`apply-consent: ${tests.length} passed`);
})();
