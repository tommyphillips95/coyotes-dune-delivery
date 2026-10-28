/**
 * One phone normalization for every function (track lookup, customer reuse,
 * schema/customer_phone_normalize.sql). "(361) 555-0100", "361.555.0100" and
 * "+1 361 555 0100" all become "3615550100". Stored phones are never rewritten.
 */
"use strict";

function phoneKey(value) {
  let d = String(value == null ? "" : value).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d;
}

function samePhone(a, b) {
  const ka = phoneKey(a);
  return ka.length >= 10 && ka === phoneKey(b);
}

/**
 * The raw input plus the usual ways a US number gets typed, so customers saved
 * before phone_normalized exists can still be matched with a plain IN (...).
 */
function phoneVariants(raw) {
  const out = new Set();
  const trimmed = String(raw == null ? "" : raw).trim();
  if (trimmed) out.add(trimmed);
  const k = phoneKey(raw);
  if (k.length === 10) {
    const a = k.slice(0, 3), b = k.slice(3, 6), c = k.slice(6);
    [
      k, "1" + k, "+1" + k,
      `(${a}) ${b}-${c}`, `(${a})${b}-${c}`, `(${a}) ${b} ${c}`,
      `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`, `${a} ${b}-${c}`,
      `+1 ${a}-${b}-${c}`, `+1 (${a}) ${b}-${c}`, `+1 ${a} ${b} ${c}`, `+1-${a}-${b}-${c}`, `+1 ${a}.${b}.${c}`,
      `1-${a}-${b}-${c}`, `1 (${a}) ${b}-${c}`, `1 ${a} ${b} ${c}`,
    ].forEach((v) => out.add(v));
  }
  return Array.from(out);
}

module.exports = { phoneKey, samePhone, phoneVariants };
