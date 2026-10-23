#!/usr/bin/env node
// Driver portal "Documents & Renewals" upload. Before this fix the portal
// POSTed FormData with no token to /update-application/<id>/documents, which
// only accepts PUT (405), so every upload failed. Now the portal sends one
// file per request to /api/upload-driver-document with the driver's Bearer
// token; the function requires an approved driver, keeps the 4 MB and
// JPG/PNG/WebP/HEIC/PDF rules and writes to the private driver-documents bucket.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
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
process.env.JWT_SECRET = "test-jwt-secret-for-doc-upload-32b!";

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FN = path.join(ROOT, "netlify/functions/upload-driver-document.js");
const load = () => require(FN);

function makeFake({ status = "approved", uploadError } = {}) {
  const f = createFakeSupabase({ applications: [{ id: "drv-1", status }, { id: "drv-2", status: "approved" }], documents: [] });
  f.uploads = [];
  f.storage = { from(bucket) { return { async upload(p, data, opts) {
    f.uploads.push({ bucket, path: p, data: Buffer.from(data), opts });
    return uploadError ? { error: { message: uploadError } } : { data: { path: p }, error: null };
  } }; } };
  return f;
}
const tok = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "1h" });
const driverTok = (id = "drv-1") => tok({ role: "driver", driver_id: id });

async function event({ files = [], fields = {}, token, method = "POST" }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append(f.field || "document", new Blob([f.data], { type: f.type || "application/octet-stream" }), f.name);
  const req = new Request("http://x/", { method: "POST", body: fd });
  const buf = Buffer.from(await req.arrayBuffer());
  const headers = { "content-type": req.headers.get("content-type") };
  if (token) headers.authorization = "Bearer " + token;
  return { httpMethod: method, headers, body: buf.toString("base64"), isBase64Encoded: true };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32)]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");

const tests = [];
const t = (n, f) => tests.push([n, f]);

t("portal posts to the upload function with the driver token, one file per request", () => {
  const js = read("frontend/driver/driver.js");
  const fnBody = js.slice(js.indexOf("async function onUploadSubmit"), js.indexOf("// Document files aren't sent"));
  assert.ok(!/update-application\/'\s*\+\s*session\.applicantId\s*\+\s*'\/documents/.test(js), "old 405 URL gone");
  assert.ok(/API_BASE \+ '\/upload-driver-document'/.test(fnBody), "new URL");
  assert.ok(/method: 'POST'/.test(fnBody));
  assert.ok(/'Authorization': 'Bearer ' \+ session\.token/.test(fnBody), "Bearer token");
  assert.ok(/fd\.append\('document', f, f\.name\)/.test(fnBody), "field name matches function");
  assert.ok(!/fd\.append\('email'/.test(fnBody), "no email identity");
  assert.ok(/4 \* 1024 \* 1024/.test(js) && /webp\|heic\|heif\|pdf/.test(js), "client limits match");
  assert.ok(/accept="[^"]*\.webp[^"]*\.heic/.test(read("frontend/driver/index.html")), "file picker accepts WebP/HEIC");
});

t("function exists and its field name matches the portal", () => {
  assert.ok(fs.existsSync(FN), "netlify/functions/upload-driver-document.js");
  assert.ok(/const FIELD = "document"/.test(fs.readFileSync(FN, "utf8")));
});

t("no token → 401, nothing stored", async () => {
  fake = makeFake();
  const r = await load().handler(await event({ files: [{ name: "a.jpg", data: JPEG }] }));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(fake.uploads.length, 0);
});

t("admin/customer tokens are refused (403)", async () => {
  fake = makeFake();
  for (const c of [{ role: "admin", user: "a" }, { role: "customer", order_id: "o1" }]) {
    const r = await load().handler(await event({ files: [{ name: "a.jpg", data: JPEG }], token: tok(c) }));
    assert.strictEqual(r.statusCode, 403, JSON.stringify(c));
  }
  assert.strictEqual(fake.uploads.length, 0);
});

t("de-approved driver → 403", async () => {
  fake = makeFake({ status: "rejected" });
  const r = await load().handler(await event({ files: [{ name: "a.jpg", data: JPEG }], token: driverTok() }));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(fake.uploads.length, 0);
});

t("GET → 405; OPTIONS allows Authorization", async () => {
  fake = makeFake();
  assert.strictEqual((await load().handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
  const o = await load().handler({ httpMethod: "OPTIONS", headers: {} });
  assert.strictEqual(o.statusCode, 204);
  assert.ok(/Authorization/.test(o.headers["Access-Control-Allow-Headers"]));
});

t("JPG/PNG/WebP/HEIC/PDF stored privately under the token's driver", async () => {
  const cases = [["a.jpg", JPEG, "image/jpeg", "jpg"], ["b.png", PNG, "image/png", "png"], ["c.webp", WEBP, "image/webp", "webp"], ["d.heic", HEIC, "image/heic", "heic"], ["e.pdf", PDF, "application/pdf", "pdf"]];
  for (const [name, data, mime, ext] of cases) {
    fake = makeFake();
    const r = await load().handler(await event({ files: [{ name, data }], fields: { applicantId: "drv-2" }, token: driverTok() }));
    assert.strictEqual(r.statusCode, 200, name + " " + r.body);
    const u = fake.uploads[0];
    assert.strictEqual(u.bucket, "driver-documents");
    assert.ok(u.path.startsWith("applications/drv-1/document-") && u.path.endsWith("." + ext), u.path);
    assert.strictEqual(u.opts.contentType, mime);
    assert.ok(u.data.equals(data));
    const rows = fake._db ? fake._db.documents : null;
    const body = JSON.parse(r.body);
    assert.ok(!/https?:/.test(r.body) && !body.path, "no URL/path returned");
    if (rows) assert.strictEqual(rows[0].application_id, "drv-1");
  }
});

t("documents row records the upload", async () => {
  fake = makeFake();
  await load().handler(await event({ files: [{ name: "renewal.pdf", data: PDF }], token: driverTok() }));
  const { data } = await fake.from("documents").select("*");
  assert.strictEqual(data.length, 1);
  assert.deepStrictEqual([data[0].application_id, data[0].file_type, data[0].filename], ["drv-1", "driver_upload", "renewal.pdf"]);
  assert.ok(data[0].storage_path.startsWith("applications/drv-1/"));
});

t("over 4 MB → 413; wrong type (by bytes) → 415; none/two files → 400", async () => {
  fake = makeFake();
  const h = load().handler;
  const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
  assert.strictEqual((await h(await event({ files: [{ name: "big.jpg", data: big }], token: driverTok() }))).statusCode, 413);
  const exact = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024 - JPEG.length)]);
  assert.strictEqual((await h(await event({ files: [{ name: "ok.jpg", data: exact }], token: driverTok() }))).statusCode, 200, "exactly 4 MB ok");
  const r = await h(await event({ files: [{ name: "x.jpg", data: Buffer.from("MZ not really a jpeg at all") }], token: driverTok() }));
  assert.strictEqual(r.statusCode, 415);
  assert.ok(/JPG, PNG, WebP, HEIC or PDF/.test(JSON.parse(r.body).error));
  assert.strictEqual((await h(await event({ files: [], fields: { a: "b" }, token: driverTok() }))).statusCode, 400);
  assert.strictEqual((await h(await event({ files: [{ name: "a.jpg", data: JPEG }, { name: "b.pdf", data: PDF }], token: driverTok() }))).statusCode, 400);
  assert.strictEqual(fake.uploads.length, 1, "only the exact-4MB file stored");
});

t("storage failure → 502 with a retry message", async () => {
  fake = makeFake({ uploadError: "Bucket not found" });
  const r = await load().handler(await event({ files: [{ name: "a.jpg", data: JPEG }], token: driverTok() }));
  assert.strictEqual(r.statusCode, 502);
  assert.ok(!/Bucket/.test(r.body));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  console.log(failed ? `${failed} failed` : `driver-document-upload: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
