/**
 * Insurance card file rules for the driver application, and where it is kept.
 *
 * Size: 4 MB. Netlify buffered functions accept about 6 MB per request and the
 * body arrives base64-encoded (+33%), so 4 MB of file plus the text fields fits
 * with room to spare. The apply page checks the same limit before sending.
 *
 * Type: decided by the file's first bytes, not by its name or the browser's
 * label: JPEG, PNG, WebP, HEIC/HEIF (iPhone photos) or PDF.
 *
 * Storage: the private Supabase Storage bucket "driver-documents" (schema.sql),
 * path applications/<application id>/insurance-card-<time>.<ext>, plus a row in
 * the documents table (file_type "insurance_card", storage_path). No public URL.
 */
"use strict";

const MAX_BYTES = 4 * 1024 * 1024;
const BUCKET = "driver-documents";
const FIELD = "insuranceCard";
const ALLOWED_LABEL = "JPG, PNG, WebP, HEIC or PDF";

const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"];

/** { mime, ext } from magic bytes, or null when it is not an allowed type. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (buf.slice(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.includes(buf.slice(8, 12).toString("latin1"))) return { mime: "image/heic", ext: "heic" };
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  return null;
}

// Rounded up, so a file just over the limit never reads as "4.0 MB".
function mb(bytes) {
  return (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1) + " MB";
}

/**
 * Check the uploaded part. Returns { ok: true, file: { data, mime, ext, filename } }
 * or { ok: false, status, error } with a message for the applicant.
 */
function check(part) {
  if (!part || !part.data || part.data.length === 0) {
    return { ok: false, status: 400, error: "Please upload a photo or PDF of your insurance card." };
  }
  if (part.data.length > MAX_BYTES) {
    return { ok: false, status: 413, error: "Your insurance card file is too large (" + mb(part.data.length) + "). The limit is " + (MAX_BYTES / (1024 * 1024)) + " MB. Please upload a smaller photo or PDF." };
  }
  const t = sniff(part.data);
  if (!t) {
    return { ok: false, status: 415, error: "Your insurance card must be a " + ALLOWED_LABEL + " file." };
  }
  const filename = String(part.filename || "").replace(/[\\/]/g, "_").replace(/[^\w.\- ]/g, "").trim().slice(0, 120) || "insurance-card." + t.ext;
  return { ok: true, file: { data: part.data, mime: t.mime, ext: t.ext, filename } };
}

/**
 * Upload to Storage and record it in documents. Never throws: returns
 * { stored: true, path } or { stored: false, reason } (the application itself
 * is already saved; the caller notes the failure for admin).
 */
async function store(supabase, applicationId, file) {
  const path = "applications/" + applicationId + "/insurance-card-" + Date.now() + "." + file.ext;
  try {
    if (!supabase.storage || typeof supabase.storage.from !== "function") return { stored: false, reason: "storage_unavailable" };
    const up = await supabase.storage.from(BUCKET).upload(path, file.data, { contentType: file.mime, upsert: false });
    if (up && up.error) {
      console.error("[submit-application] insurance card upload failed:", up.error.message || up.error);
      return { stored: false, reason: "upload_failed" };
    }
    const doc = await supabase.from("documents").insert([{
      application_id: applicationId, filename: file.filename, file_type: "insurance_card", storage_path: path,
    }]);
    if (doc && doc.error) {
      console.error("[submit-application] documents row failed (file is in storage at " + path + "):", doc.error.message || doc.error);
      return { stored: true, path, documentRow: false };
    }
    return { stored: true, path, documentRow: true };
  } catch (err) {
    console.error("[submit-application] insurance card store threw:", err && err.message);
    return { stored: false, reason: "upload_failed" };
  }
}

module.exports = { MAX_BYTES, BUCKET, FIELD, ALLOWED_LABEL, sniff, check, store };
