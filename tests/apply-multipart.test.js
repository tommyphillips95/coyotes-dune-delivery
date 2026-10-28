#!/usr/bin/env node
// Driver application, real multipart: the apply page sends a browser FormData
// (every field of frontend/apply/index.html + the insuranceCard file), Netlify
// hands it to submit-application base64-encoded. Before this fix the handler
// did JSON.parse on that body and every real submission got a 500.
// Bodies here are encoded by the platform FormData/Request (same multipart
// encoder spec as browsers). Supabase (DB + Storage) is faked; no network.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
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
const submit = require(path.join(ROOT, "netlify/functions/submit-application.js"));
const card = require(path.join(ROOT, "netlify/functions/_insurance-card.js"));
const mp = require(path.join(ROOT, "netlify/functions/_multipart.js"));

/** Fake Supabase with a Storage bucket that records uploads (or fails). */
function makeFake({ uploadError } = {}) {
  const f = createFakeSupabase({ applications: [], documents: [] });
  f.uploads = [];
  f.storage = {
    from(bucket) {
      return {
        async upload(p, data, opts) {
          f.uploads.push({ bucket, path: p, data: Buffer.from(data), opts });
          return uploadError ? { data: null, error: { message: uploadError } } : { data: { path: p }, error: null };
        },
      };
    },
  };
  return f;
}

// ── The real form's fields, read from the HTML ─────────────────────────────
const html = read("frontend/apply/index.html");
const formFields = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => {
  const tag = m[0];
  const attr = (a) => { const r = new RegExp("\\b" + a + "=\"([^\"]*)\"").exec(tag); return r ? r[1] : null; };
  return { name: attr("name") || attr("id"), type: m[1] === "input" ? (attr("type") || "text") : m[1], required: /\brequired\b/.test(tag) };
}).filter((f) => f.name);

// Test values for every field a driver fills in (test data only).
const VALUES = {
  firstName: "Smoke", lastName: "Test", email: "smoke.test@example.com", phone: "(361) 555-0100",
  dob: "1990-04-02", address: "123 Test St", city: "Port Aransas", state: "TX", zip: "78373",
  emergencyName: "Test Contact", emergencyPhone: "(361) 555-0101",
  licenseNumber: "DL1234567", licenseState: "TX", licenseExpiry: "2030-01-01",
  vehicleMake: "Toyota", vehicleModel: "Tacoma", vehicleYear: "2020", vehicleColor: "Silver",
  vehicleClass: "4x4", licensePlate: "TST-1234",
  insuranceProvider: "Test Mutual", policyNumber: "POL-123456", policyExpiry: "2030-01-01",
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0 fake card photo"), Buffer.alloc(2048, 7)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

/**
 * Same steps as submitApplication() in frontend/js/apply.js: every input,
 * select, textarea in the steps (checkboxes as "true"/"false", file inputs
 * skipped), then the insurance card appended as "insuranceCard".
 */
function browserFormData({ file, override = {}, omit = [] } = {}) {
  const fd = new FormData();
  for (const f of formFields) {
    if (omit.includes(f.name) || f.type === "file") continue;
    if (f.type === "checkbox") { fd.append(f.name, String(override[f.name] != null ? override[f.name] : true)); continue; }
    const v = override[f.name] != null ? override[f.name] : VALUES[f.name];
    assert.ok(v != null, "test has a value for apply form field " + f.name);
    fd.append(f.name, v);
  }
  for (const [k, v] of Object.entries(override)) if (!formFields.some((f) => f.name === k)) fd.append(k, v);
  if (file) fd.append("insuranceCard", new File([file.data], file.name, { type: file.type }));
  return fd;
}

/** Encode like the browser does and wrap it the way Netlify delivers it. */
async function netlifyEvent(fd, { base64 = true } = {}) {
  const req = new Request("https://coyote-dune-delivery.netlify.app/api/submit-application", { method: "POST", body: fd });
  const ct = req.headers.get("content-type");
  const buf = Buffer.from(await req.arrayBuffer());
  return {
    httpMethod: "POST",
    headers: { "content-type": ct, origin: "https://coyote-dune-delivery.netlify.app" },
    body: base64 ? buf.toString("base64") : buf.toString("utf8"),
    isBase64Encoded: base64,
    _raw: buf,
  };
}

const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const send = (event) => quiet(() => submit.handler(event));
const B = (r) => JSON.parse(r.body);

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("the apply page really sends multipart: FormData with the file and no JSON Content-Type", () => {
  const src = read("frontend/js/apply.js");
  const fn = src.slice(src.indexOf("async function submitApplication"), src.indexOf("function showSubmitError"));
  assert.ok(/new FormData\(\)/.test(fn));
  assert.ok(/formData\.append\('insuranceCard', uploadedFiles\.insuranceCard\)/.test(fn));
  assert.ok(/if \(hasFile\) \{\s*payload = formData;/.test(fn), "file → FormData body (browser sets multipart boundary)");
  // Step 3 can't be passed without a file, so the JSON branch never runs from the page.
  assert.ok(/if \(!uploadedFiles\.insuranceCard\)/.test(src));
  const file = formFields.find((f) => f.type === "file");
  assert.deepStrictEqual([file.name, file.required], ["insuranceCard", true]);
  assert.ok(formFields.some((f) => f.name === "vehicleClass" && f.required), "#73 vehicle type is on the form");
});

test("full real form + JPEG card (base64 like Netlify) → 201, row saved, card in Storage + documents", async () => {
  fake = makeFake();
  const ev = await netlifyEvent(browserFormData({ file: { data: JPEG, name: "insurance card.jpg", type: "image/jpeg" } }));
  assert.match(ev.headers["content-type"], /^multipart\/form-data; boundary=/);
  const r = await send(ev);
  assert.strictEqual(r.statusCode, 201, r.body);
  const body = B(r);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.insuranceCardStored, true);
  const row = fake.db.applications[0];
  assert.strictEqual(body.applicationId, row.id);
  assert.strictEqual(row.first_name, "Smoke");
  assert.strictEqual(row.email, "smoke.test@example.com");
  assert.strictEqual(row.phone, "(361) 555-0100");
  assert.strictEqual(row.zip_code, "78373");
  assert.strictEqual(row.vehicle_class, "4x4");
  assert.strictEqual(row.vehicle_class_reported, "4x4");
  assert.strictEqual(row.insurance_policy_number, "POL-123456");
  assert.strictEqual(row.background_check_consent, true, "checkbox 'true' string → boolean");
  assert.strictEqual(row.status, "pending");
  assert.strictEqual(fake.uploads.length, 1);
  const up = fake.uploads[0];
  assert.strictEqual(up.bucket, "driver-documents");
  assert.match(up.path, new RegExp("^applications/" + row.id + "/insurance-card-\\d+\\.jpg$"));
  assert.strictEqual(up.opts.contentType, "image/jpeg");
  assert.strictEqual(up.opts.upsert, false);
  assert.ok(up.data.equals(JPEG), "file bytes arrive intact");
  assert.deepStrictEqual(fake.db.documents.map((d) => [d.application_id, d.file_type, d.storage_path, d.filename]),
    [[row.id, "insurance_card", up.path, "insurance card.jpg"]]);
});

test("PDF card, body not base64-encoded (netlify dev text body) → 201", async () => {
  fake = makeFake();
  const r = await send(await netlifyEvent(browserFormData({ file: { data: PDF, name: "card.pdf", type: "application/pdf" } }), { base64: false }));
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.strictEqual(fake.uploads[0].opts.contentType, "application/pdf");
  assert.match(fake.uploads[0].path, /\.pdf$/);
});

test("HEIC phone photo with no browser type → accepted by its bytes", async () => {
  fake = makeFake();
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64, 1)]);
  const r = await send(await netlifyEvent(browserFormData({ file: { data: heic, name: "IMG_0001.HEIC", type: "" } })));
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.strictEqual(fake.uploads[0].opts.contentType, "image/heic");
});

test("missing file → 400 on insuranceCard, nothing saved", async () => {
  fake = makeFake();
  const r = await send(await netlifyEvent(browserFormData({ file: null })));
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(B(r), { error: "Please upload a photo or PDF of your insurance card.", field: "insuranceCard" });
  assert.strictEqual(fake.db.applications.length, 0);
  assert.strictEqual(fake.uploads.length, 0);
});

test("empty file part (what a browser sends for an empty file input) → 400", async () => {
  fake = makeFake();
  const fd = browserFormData({ file: null });
  fd.append("insuranceCard", new File([], "", { type: "application/octet-stream" }));
  const r = await send(await netlifyEvent(fd));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(B(r).field, "insuranceCard");
  assert.strictEqual(fake.db.applications.length, 0);
});

test("oversize file (4 MB + 1 byte) → 413 with the size and the limit, nothing saved", async () => {
  fake = makeFake();
  const big = Buffer.concat([JPEG.slice(0, 6), Buffer.alloc(card.MAX_BYTES + 1 - 6, 0)]);
  const r = await send(await netlifyEvent(browserFormData({ file: { data: big, name: "huge.jpg", type: "image/jpeg" } })));
  assert.strictEqual(r.statusCode, 413);
  assert.deepStrictEqual(B(r), { error: "Your insurance card file is too large (4.1 MB). The limit is 4 MB. Please upload a smaller photo or PDF.", field: "insuranceCard" });
  assert.strictEqual(fake.db.applications.length, 0);
  // Exactly the limit is fine.
  fake = makeFake();
  const max = Buffer.concat([JPEG.slice(0, 6), Buffer.alloc(card.MAX_BYTES - 6, 0)]);
  assert.strictEqual((await send(await netlifyEvent(browserFormData({ file: { data: max, name: "max.jpg", type: "image/jpeg" } })))).statusCode, 201);
});

test("request far over the cap → 413 before parsing", async () => {
  fake = makeFake();
  const huge = Buffer.alloc(card.MAX_BYTES + 600 * 1024, 0x41);
  const r = await send(await netlifyEvent(browserFormData({ file: { data: huge, name: "x.jpg", type: "image/jpeg" } })));
  assert.strictEqual(r.statusCode, 413);
  assert.match(B(r).error, /too large.*4 MB/);
  assert.strictEqual(fake.db.applications.length, 0);
});

test("wrong type → 415: a GIF, an .exe renamed .pdf, and text labelled image/jpeg", async () => {
  const cases = [
    { data: Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100, 0)]), name: "card.gif", type: "image/gif" },
    { data: Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(100, 0)]), name: "card.pdf", type: "application/pdf" },
    { data: Buffer.from("this is not a picture of an insurance card"), name: "card.jpg", type: "image/jpeg" },
  ];
  for (const file of cases) {
    fake = makeFake();
    const r = await send(await netlifyEvent(browserFormData({ file })));
    assert.strictEqual(r.statusCode, 415, file.name);
    assert.deepStrictEqual(B(r), { error: "Your insurance card must be a JPG, PNG, WebP, HEIC or PDF file.", field: "insuranceCard" });
    assert.strictEqual(fake.db.applications.length, 0);
  }
});

test("multipart keeps #73 vehicle type validation: missing or bad → 400 vehicleClass", async () => {
  for (const opt of [{ omit: ["vehicleClass"] }, { override: { vehicleClass: "" } }, { override: { vehicleClass: "tank" } }]) {
    fake = makeFake();
    const r = await send(await netlifyEvent(browserFormData(Object.assign({ file: { data: JPEG, name: "c.jpg", type: "image/jpeg" } }, opt))));
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(B(r).field, "vehicleClass");
    assert.match(B(r).error, /2wd, awd, 4x4, utv/);
    assert.strictEqual(fake.db.applications.length, 0);
  }
  for (const cls of ["2wd", "awd", "4x4", "utv"]) {
    fake = makeFake();
    const r = await send(await netlifyEvent(browserFormData({ file: { data: JPEG, name: "c.jpg", type: "image/jpeg" }, override: { vehicleClass: cls } })));
    assert.strictEqual(r.statusCode, 201, cls);
    assert.strictEqual(fake.db.applications[0].vehicle_class, cls);
  }
});

test("multipart still refuses SSN / bank fields", async () => {
  fake = makeFake();
  const r = await send(await netlifyEvent(browserFormData({ file: { data: JPEG, name: "c.jpg", type: "image/jpeg" }, override: { ssn: "123-45-6789" } })));
  assert.strictEqual(r.statusCode, 400);
  assert.match(B(r).error, /Do not send SSN or bank details/);
  assert.strictEqual(fake.db.applications.length, 0);
});

test("Storage fails (e.g. bucket not created) → application still saved, admin note added", async () => {
  fake = makeFake({ uploadError: "Bucket not found" });
  const r = await send(await netlifyEvent(browserFormData({ file: { data: JPEG, name: "c.jpg", type: "image/jpeg" } })));
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.strictEqual(B(r).insuranceCardStored, false);
  assert.strictEqual(fake.db.applications.length, 1);
  assert.match(fake.db.applications[0].notes, /Insurance card upload failed .*Ask the driver to send it again/);
  assert.strictEqual(fake.db.documents.length, 0);
});

test("JSON submissions (no file) still work, and bad JSON is a 400 not a 500", async () => {
  fake = makeFake();
  const r = await send({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstName: "J", lastName: "S", email: "j@example.com", vehicleClass: "2wd", bgConsent: true, bgDisclosureRead: true, esignature: true, termsAgree: true }) });
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.ok(!("insuranceCardStored" in B(r)));
  assert.strictEqual(fake.db.applications[0].background_check_consent, true);
  assert.strictEqual(fake.uploads.length, 0);
  const bad = await send({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.strictEqual(bad.statusCode, 400);
});

test("parser: quoted boundary, ';' in a filename, truncated body", () => {
  const b = "x;y=1";
  const raw = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\nhello\r\n--${b}\r\nContent-Disposition: form-data; name="f"; filename="a;b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1\r\n--${b}--\r\n`);
  const out = mp.parseMultipart(raw, `multipart/form-data; boundary="${b}"`);
  assert.deepStrictEqual(out.fields, { a: "hello" });
  assert.deepStrictEqual([out.files[0].field, out.files[0].filename, out.files[0].data.toString()], ["f", "a;b.pdf", "%PDF-1"]);
  assert.throws(() => mp.parseMultipart(raw.slice(0, raw.length - 20), `multipart/form-data; boundary="${b}"`), (e) => e.status === 400);
  assert.throws(() => mp.parseMultipart(raw, "multipart/form-data"), (e) => e.status === 400);
});

test("LAUNCH.md: one top 'Before the next production deploy' block (steps 5, 6, 7 + bucket + deploy, in order); no 'builds from main'", () => {
  const md = read("LAUNCH.md");
  const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.strictEqual(heads[0], "Before the next production deploy", "block is the first section");
  assert.strictEqual(heads.filter((h) => /^Before the (next )?production deploy/.test(h)).length, 1, "only one such list");
  const block = md.slice(md.indexOf("## Before the next production deploy"), md.indexOf("\n## ", md.indexOf("## Before the next production deploy") + 5));
  assert.ok(block.includes("Production is deployed by hand with the Netlify CLI (the site is not linked to Git; live today is `main` @ 5e41c41). Whoever runs the next production deploy does these first:"));
  const order = ["schema/order_idempotency.sql", "schema/customer_phone_normalize.sql", "schema/vehicle_verification.sql", "`driver-documents`", "Then the production deploy"].map((t) => block.indexOf(t));
  order.forEach((i, n) => assert.ok(i > -1 && (n === 0 || i > order[n - 1]), "step order " + n));
  ["schema/order_idempotency.sql", "schema/customer_phone_normalize.sql", "schema/vehicle_verification.sql"].forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, f)), f));
  assert.ok(/Step 5 \(required\)/.test(block) && /Step 6 \(optional\)/.test(block) && /If you skip this step/.test(block) && /Step 7 \(required\)/.test(block));
  assert.ok(/Save & mark verified/.test(block) && /beach orders get no driver/.test(block));
  assert.ok(/Public: off\*\*, file size limit \*\*4 MB\*\*/.test(block) && block.includes(card.BUCKET));
  for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]) assert.ok(block.includes(t), t);
  assert.ok(!/builds from `main`/.test(md) && !/merging this branch into `main` \*\*is\*\* the production deploy/.test(md));
  assert.ok(!/before-the-production-deploy-must-do/.test(md), "old anchor gone");
  // Run order + Step 7 still say MUST before the production deploy, and the deploy checklist keeps its item.
  assert.ok(/^7\. .*MUST be run, and your beach drivers verified in admin, BEFORE the production deploy.*`schema\/vehicle_verification\.sql`/m.test(md));
  const step7 = md.slice(md.indexOf("### Step 7 on Supabase"), md.indexOf("### Idempotency"));
  assert.ok(/MUST be done BEFORE the production deploy/.test(step7) && /beach \(4x4\) orders get no driver/.test(step7));
  const gate = md.slice(md.indexOf("## PR #2 merge gate"), md.indexOf("## To go live this week"));
  assert.ok(/- \[ \] \*\*MUST, before the production deploy:\*\* SQL step 7/.test(gate), "deploy checklist item");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); }
  }
  console.log(failed ? `${failed} failed` : `apply-multipart: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
