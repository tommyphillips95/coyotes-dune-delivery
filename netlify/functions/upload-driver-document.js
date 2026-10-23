/**
 * Netlify Function: driver portal document upload (renewed insurance card,
 * license, registration...).
 * POST /api/upload-driver-document
 *
 * Auth: the driver's login token (Authorization: Bearer). The driver must
 * still be approved (assertDriverActive). The document is always filed under
 * the token's driver; any applicantId in the form is ignored.
 *
 * Body: multipart/form-data with ONE file in the field "document" (the portal
 * sends one request per file so each stays under Netlify's ~6 MB request cap).
 * Rules are the apply page's (_insurance-card.js): 4 MB, and the type is
 * decided by the file's first bytes: JPG, PNG, WebP, HEIC/HEIF or PDF.
 *
 * Storage: private bucket "driver-documents", path
 * applications/<driver id>/document-<time>.<ext>, plus a documents row
 * (file_type "driver_upload", storage_path). No public URL is created or returned.
 */
"use strict";

const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
const { headers: corsHeaders } = require("./_cors");
const { requireDriver, assertDriverActive, jsonError } = require("./_auth");
const multipart = require("./_multipart");
const card = require("./_insurance-card");

const FIELD = "document";
const MAX_BODY_BYTES = card.MAX_BYTES + 512 * 1024;
const LIMIT_MB = card.MAX_BYTES / (1024 * 1024);

function cleanName(name, ext) {
  return String(name || "").replace(/[\\/]/g, "_").replace(/[^\w.\- ]/g, "").trim().slice(0, 120) || "document." + ext;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event, {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });

  let auth;
  try {
    auth = { kind: "driver", decoded: requireDriver(event) };
  } catch (err) {
    return jsonError(headers, err);
  }

  if (!multipart.isMultipart(event)) return reply(400, { error: "Send the file as multipart/form-data in the \"document\" field." });
  const raw = multipart.eventBody(event);
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: `That file is too large. The limit is ${LIMIT_MB} MB per file.` });
  let parsed;
  try {
    parsed = multipart.parseMultipart(raw, multipart.header(event, "content-type"), { maxParts: 10 });
  } catch (err) {
    return reply(err.status || 400, { error: err.message });
  }
  const files = parsed.files.filter((f) => f.field === FIELD && (f.filename || f.data.length));
  if (files.length !== 1) return reply(400, { error: files.length ? "Upload one file at a time." : "Please choose a photo or PDF to upload." });
  const part = files[0];
  if (!part.data.length) return reply(400, { error: "That file is empty." });
  if (part.data.length > card.MAX_BYTES) return reply(413, { error: `That file is too large. The limit is ${LIMIT_MB} MB per file.` });
  const type = card.sniff(part.data);
  if (!type) return reply(415, { error: `Documents must be a ${card.ALLOWED_LABEL} file.` });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await assertDriverActive(supabase, auth);
    const driverId = String(auth.decoded.driver_id);
    if (!supabase.storage || typeof supabase.storage.from !== "function") return reply(503, { error: "Document storage isn't available right now. Please try again later." });
    const filename = cleanName(part.filename, type.ext);
    const path = `applications/${driverId}/document-${Date.now()}.${type.ext}`;
    const up = await supabase.storage.from(card.BUCKET).upload(path, part.data, { contentType: type.mime, upsert: false });
    if (up && up.error) {
      console.error("[upload-driver-document] storage upload failed:", up.error.message || up.error);
      return reply(502, { error: "We couldn't save that file. Please try again." });
    }
    const doc = await supabase.from("documents").insert([{ application_id: driverId, filename, file_type: "driver_upload", storage_path: path }]);
    if (doc && doc.error) console.error("[upload-driver-document] documents row failed (file is at " + path + "):", doc.error.message || doc.error);
    return reply(200, { success: true, document: { filename, type: type.mime } });
  } catch (err) {
    if (err && err.status) return jsonError(headers, err);
    return serverError(headers, err, "Failed to upload document", "upload-driver-document");
  }
};
