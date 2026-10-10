/**
 * Tiny in-memory stand-in for the parts of @supabase/supabase-js the
 * dispatch/offer functions use: from().select/insert/update + eq/lt/in/
 * order/limit + maybeSingle/single. Every builder is awaitable and resolves
 * to { data, error } like the real client. No network, no deps.
 */
"use strict";

function createFakeSupabase(seed) {
  const db = {};
  Object.keys(seed || {}).forEach((t) => { db[t] = seed[t].map((r) => Object.assign({}, r)); });
  let nextId = 1;
  const calls = [];

  function table(name) {
    if (!db[name]) db[name] = [];
    return db[name];
  }

  function from(name) {
    const state = { op: "select", filters: [], orderBy: null, limitN: null, single: null, payload: null, returning: false };
    const match = (row) => state.filters.every((f) => f(row));

    function run() {
      const rows = table(name);
      let data;
      if (state.op === "insert") {
        const inserted = state.payload.map((r) => Object.assign({ id: r.id || name + "-" + nextId++ }, r));
        rows.push(...inserted);
        data = state.returning ? inserted : null;
      } else if (state.op === "update") {
        const hit = rows.filter(match);
        hit.forEach((r) => Object.assign(r, state.payload));
        data = state.returning ? hit : null;
      } else {
        data = rows.filter(match).map((r) => Object.assign({}, r));
        if (state.orderBy) {
          const { col, asc } = state.orderBy;
          data.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (state.limitN != null) data = data.slice(0, state.limitN);
      }
      calls.push({ table: name, op: state.op, payload: state.payload });
      if (state.single === "maybe") return { data: Array.isArray(data) ? data[0] || null : data, error: null };
      if (state.single === "one") {
        const row = Array.isArray(data) ? data[0] : data;
        return row ? { data: row, error: null } : { data: null, error: new Error("no rows") };
      }
      return { data, error: null };
    }

    const b = {
      select() { if (state.op !== "select") state.returning = true; return b; },
      insert(rows) { state.op = "insert"; state.payload = rows; return b; },
      update(patch) { state.op = "update"; state.payload = patch; return b; },
      eq(col, val) { state.filters.push((r) => r[col] === val); return b; },
      lt(col, val) { state.filters.push((r) => r[col] < val); return b; },
      in(col, vals) { state.filters.push((r) => vals.includes(r[col])); return b; },
      order(col, opts) { state.orderBy = { col, asc: !(opts && opts.ascending === false) }; return b; },
      limit(n) { state.limitN = n; return b; },
      maybeSingle() { state.single = "maybe"; return b; },
      single() { state.single = "one"; return b; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return b;
  }

  return { from, db, calls };
}

module.exports = { createFakeSupabase };
