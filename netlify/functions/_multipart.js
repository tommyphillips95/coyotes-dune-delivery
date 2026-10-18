/**
 * Small multipart/form-data reader for Netlify Functions (no dependencies).
 *
 * The driver apply page posts a browser FormData (text fields + the insurance
 * card file). Netlify hands such bodies to the function base64-encoded with
 * event.isBase64Encoded = true; eventBody() turns either form into a Buffer.
 *
 * parseMultipart() returns { fields: { name: string }, files: [{ field,
 * filename, contentType, data: Buffer }] }. Malformed input throws an Error
 * with status 400 so callers can answer with a clear 4xx.
 */
"use strict";

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || "");
  return "";
}

function isMultipart(event) {
  return /^multipart\/form-data\b/i.test(header(event, "content-type").trim());
}

function eventBody(event) {
  const body = event && event.body != null ? event.body : "";
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(String(body), event && event.isBase64Encoded ? "base64" : "utf8");
}

function getBoundary(contentType) {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
  const b = m ? (m[1] || m[2]) : "";
  return b && b.length <= 200 ? b : null;
}

function dispositionParam(disposition, key) {
  // name="x" or name=x; quoted values may contain ';'.
  const re = new RegExp("(?:^|;)\\s*" + key + "=(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^;]*))", "i");
  const m = re.exec(disposition);
  if (!m) return null;
  return m[1] != null ? m[1].replace(/\\(.)/g, "$1") : m[2].trim();
}

function parseHeaders(text) {
  const out = {};
  text.split("\r\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return out;
}

function parseMultipart(buf, contentType, opts) {
  const o = Object.assign({ maxParts: 100 }, opts);
  const boundary = getBoundary(contentType);
  if (!boundary) throw badRequest("The upload is missing its multipart boundary. Please try again.");
  const delim = Buffer.from("--" + boundary);
  const fields = {};
  const files = [];

  let pos = buf.indexOf(delim);
  if (pos === -1) throw badRequest("The upload could not be read. Please try again.");
  let parts = 0;
  for (;;) {
    pos += delim.length;
    // "--" right after a delimiter ends the body.
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
    // Skip optional transport padding, then the CRLF after the delimiter.
    while (buf[pos] === 0x20 || buf[pos] === 0x09) pos++;
    if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) throw badRequest("The upload could not be read. Please try again.");
    pos += 2;

    const headEnd = buf.indexOf("\r\n\r\n", pos);
    if (headEnd === -1) throw badRequest("The upload could not be read. Please try again.");
    const headers = parseHeaders(buf.slice(pos, headEnd).toString("utf8"));
    const dataStart = headEnd + 4;
    const next = buf.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), dataStart);
    if (next === -1) throw badRequest("The upload was cut off. Please try again.");
    const data = buf.slice(dataStart, next);

    if (++parts > o.maxParts) throw badRequest("Too many fields in the upload.");
    const disp = headers["content-disposition"] || "";
    const name = dispositionParam(disp, "name");
    if (name) {
      const filename = dispositionParam(disp, "filename");
      if (filename != null) {
        files.push({ field: name, filename, contentType: (headers["content-type"] || "").toLowerCase(), data });
      } else if (!Object.prototype.hasOwnProperty.call(fields, name)) {
        fields[name] = data.toString("utf8");
      }
    }
    pos = next + 2; // at the delimiter again
  }
  return { fields, files };
}

module.exports = { isMultipart, eventBody, getBoundary, parseMultipart, header };
