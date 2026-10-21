// Migration order check (Phase 2 review, finding 8).
//
// 0141 re-declares objects that sibling branches' migrations declared before
// it — guard_order_update (last before it in 0061), lock_restaurant_privileged_fields
// (0056), the "delivery_events — read" policy (0081). `create or replace` means the
// LAST one applied wins, so the required order is 0061 → 0081 → 0141 (→ 0142+).
// Applied out of order (`supabase db push --include-all`, a sibling deployed
// later), 0141's zone lock or rider scoping would silently revert.
//
// This applies every declaration of those functions in file order in PGlite and
// requires the result to keep what each era added; then applies 0061 AFTER 0141
// and requires the check to notice — proof that it would catch the wrong order.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17   Usage: node scripts/qa/sql/migration-order.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../../supabase/migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const read = (f) => readFileSync(new URL(f, dir), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) passed++; else failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); };

/** Every `create or replace function public.<name>(...)` block in a file, up to its closing `$$;`. */
function declarations(sql, name) {
  const out = [];
  const re = new RegExp(`create or replace function public\\.${name}\\([^)]*\\)[\\s\\S]*?\\n\\$\\$;`, "g");
  for (const m of sql.matchAll(re)) out.push(m[0]);
  return out;
}

async function finalBody(name, order) {
  const db = new PGlite();
  await db.exec(`create schema if not exists auth;`);
  for (const f of order) for (const block of declarations(read(f), name)) await db.exec(block);
  const r = await db.query(`select prosrc from pg_proc where proname = $1`, [name]);
  await db.close();
  return r.rows[0]?.prosrc ?? "";
}

const declaring = (name) => files.filter((f) => declarations(read(f), name).length > 0);

console.log("── guard_order_update, applied in file order ──");
{
  const order = declaring("guard_order_update");
  console.log(`  declared in: ${order.join(", ")}`);
  const body = await finalBody("guard_order_update", order);
  ok("keeps 0051's cancellation provenance lock", body.includes("'cancelled_by'"));
  ok("keeps 0061's preparing_at lock", body.includes("'preparing_at'"));
  ok("keeps 0141's zone_id lock", body.includes("'zone_id'"));
  ok("the last declaration is 0141 or later", order.at(-1) >= "0141");

  const wrong = [...order.filter((f) => f !== "0061_vendor_app_foundation.sql"), "0061_vendor_app_foundation.sql"];
  const reverted = await finalBody("guard_order_update", wrong);
  ok("applying 0061 after 0141 would lose the zone lock — and this check sees it", !reverted.includes("'zone_id'"));
}

console.log("\n── lock_restaurant_privileged_fields, applied in file order ──");
{
  const order = declaring("lock_restaurant_privileged_fields");
  console.log(`  declared in: ${order.join(", ")}`);
  const body = await finalBody("lock_restaurant_privileged_fields", order);
  ok("keeps the commission lock", body.includes("commission_pct"));
  ok("keeps 0141's zone lock", body.includes("zone_id"));
}

console.log("\n── policies 0141 re-creates ──");
{
  const policy = (sql) => [...sql.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
  const ours = new Set(policy(read("0141_manager_foundation.sql")));
  for (const f of files.filter((x) => x >= "0061" && x < "0141")) {
    for (const p of policy(read(f)).filter((p) => ours.has(p))) {
      const later = files.filter((x) => x.slice(0, 4) > "0141" && policy(read(x)).includes(p));
      ok(`"${p}" (${f}) is re-created by 0141${later.length ? ` and ${later.join(", ")}` : ""}, so ${f} must be applied first`, true);
    }
  }
}

console.log("\n── the order is written down ──");
{
  const header = read("0141_manager_foundation.sql").slice(0, 4000);
  ok("0141's header states 0061 → 0081 → 0141", /0061\s*→\s*0081\s*→\s*0141/.test(header));
  const dbDoc = readFileSync(new URL("../../../docs/DATABASE.md", import.meta.url), "utf8");
  ok("docs/DATABASE.md states it too", /0061\s*→\s*0081\s*→\s*0141/.test(dbDoc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
