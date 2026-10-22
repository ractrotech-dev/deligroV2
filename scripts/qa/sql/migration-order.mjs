// Migration order check (Phase 2 review, finding 8).
//
// 0141 re-declares objects that sibling branches' migrations declared before
// it — guard_order_update (0061, 0063, 0082), lock_restaurant_privileged_fields
// (0056), log_delivery_event (0082; re-declared by 0142), and the "delivery_events —
// read" (0081) and "delivery_exceptions — read" (0082) policies. `create or replace`
// means the LAST one applied wins, so the required order is
// 0061 → 0063 → 0064 → 0081 → 0082 → 0083 → 0084 → 0085 → 0086 → 0087 → 0141 (→ 0142+). 0083 matters for a
// grant: it grants record_rider_payout to signed-in users and 0152 revokes it
// (admins pay through payment_requests), so 0083 applied after 0152 would
// hand back the one-person payout.
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

async function finalBody(name, order, prelude = "") {
  const db = new PGlite();
  await db.exec(`create schema if not exists auth;`);
  if (prelude) await db.exec(prelude);
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
  ok("keeps 0063's invoice_no / invoice_at locks", body.includes("'invoice_no'") && body.includes("'invoice_at'"));
  ok("keeps 0082's delivery_instructions lock", body.includes("'delivery_instructions'"));
  ok("the last declaration is 0141 or later", order.at(-1) >= "0141");

  for (const late of ["0061_vendor_app_foundation.sql", "0063_order_invoices.sql", "0082_rider_jobs.sql"]) {
    if (!order.includes(late)) continue;
    const wrong = [...order.filter((f) => f !== late), late];
    const reverted = await finalBody("guard_order_update", wrong);
    if (late === "0082_rider_jobs.sql") {
      // Rider 0082 (since its fix 3c40ee3) carries the sibling branches' columns in
      // its own list, zone_id included, so applying it late no longer unlocks them.
      ok("applying 0082 after 0141 keeps the zone lock (0082 lists the sibling columns itself)", reverted.includes("'zone_id'"));
    } else {
      ok(`applying ${late.slice(0, 4)} after 0141 would lose the zone lock — and this check sees it`, !reverted.includes("'zone_id'"));
    }
  }
}

console.log("\n── lock_restaurant_privileged_fields, applied in file order ──");
{
  const order = declaring("lock_restaurant_privileged_fields");
  console.log(`  declared in: ${order.join(", ")}`);
  const body = await finalBody("lock_restaurant_privileged_fields", order);
  ok("keeps the commission lock", body.includes("commission_pct"));
  ok("keeps 0141's zone lock", body.includes("zone_id"));
  ok("keeps 0145's status provenance lock", body.includes("status_reason") && body.includes("status_changed_by"));
  ok("the last declaration is 0145 or later", order.at(-1) >= "0145");
}

console.log("\n── guard_order_item_insert, applied in file order ──");
{
  const order = declaring("guard_order_item_insert");
  console.log(`  declared in: ${order.join(", ")}`);
  const body = await finalBody("guard_order_item_insert", order);
  ok("keeps 0055's payment-started lock", body.includes("payment has started"));
  ok("keeps 0062's shop hours, stock and variant pricing", body.includes("restaurant_status_now") && body.includes("stock_qty") && body.includes("menu_item_variants"));
  ok("keeps 0146's moderation check", body.includes("hidden_by_ops") && body.includes("approval_status"));
  ok("the last declaration is 0146 or later", order.at(-1) >= "0146");
}

console.log("\n── log_delivery_event, applied in file order ──");
{
  const order = declaring("log_delivery_event");
  console.log(`  declared in: ${order.join(", ")}`);
  // The body declares `public.deliveries%rowtype`, so the table must exist to compile it.
  const deliveries = `create table public.deliveries (id uuid, order_id uuid, driver_id uuid, offered_driver_id uuid,
    status text, last_action_id uuid, driver_lat double precision, driver_lng double precision,
    arrived_pickup_at timestamptz, departed_pickup_at timestamptz, arrived_drop_at timestamptz,
    pickup_method text, delivery_method text, failure_reason text, correction_reason text);`;
  const body = await finalBody("log_delivery_event", order, deliveries);
  ok("keeps 0082's released event", body.includes("'released'"));
  ok("keeps 0082's accepted-on-reassign", /'accepted'[\s\S]*?or reassign/.test(body));
  ok("keeps 0142's server-side actor", body.includes("deligro.actor_id"));
  ok("keeps 0142's ops reason", body.includes("deligro.ops_reason"));
  ok("the last declaration is 0142 or later", order.at(-1) >= "0142");
  if (order.includes("0082_rider_jobs.sql")) {
    const wrong = [...order.filter((f) => f !== "0082_rider_jobs.sql"), "0082_rider_jobs.sql"];
    const reverted = await finalBody("log_delivery_event", wrong, deliveries);
    ok("applying 0082 after 0142 would lose the ops actor — and this check sees it", !reverted.includes("deligro.actor_id"));
  }
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

console.log("\n── record_rider_payout's grant (0083 grants it, 0152 takes it back) ──");
{
  const stmts = (sql) =>
    [...sql.matchAll(/(?:revoke|grant)\s+execute\s+on\s+function\s+public\.record_rider_payout\([^)]*\)\s+(?:from|to)[^;]*;/g)].map((m) => m[0]);
  const run = async (order) => {
    const db = new PGlite();
    await db.exec(`create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`do $$ begin create role ${role}; exception when duplicate_object then null; end $$;`);
    }
    for (const block of declarations(read("0083_rider_money.sql"), "record_rider_payout")) await db.exec(block);
    for (const f of order) for (const st of stmts(read(f))) await db.exec(st);
    const r = await db.query(
      `select has_function_privilege('authenticated','public.record_rider_payout(uuid,date,text,text,date,text)','EXECUTE') as x`
    );
    return r.rows[0].x;
  };
  const order = files.filter((f) => stmts(read(f)).length > 0);
  ok(`declared and re-granted in ${order.map((f) => f.slice(0, 4)).join(", ")}`, order.includes("0083_rider_money.sql") && order.some((f) => f >= "0152"));
  ok("in file order nobody signed in can pay a rider alone (0152 revokes 0083's grant)", (await run(order)) === false);
  const late = [...order.filter((f) => f !== "0083_rider_money.sql"), "0083_rider_money.sql"];
  ok("applying 0083 after 0152 would hand it back — and this check sees it", (await run(late)) === true);
}

console.log("\n── the order is written down ──");
{
  const header = read("0141_manager_foundation.sql").slice(0, 4000);
  ok("0141's header states 0061 → 0063 → 0064 → 0081 → 0082 → 0083 → 0084 → 0085 → 0086 → 0087 → 0141", /0061\s*→\s*0063\s*→\s*0064\s*→\s*0081\s*→\s*0082\s*→\s*0083\s*→\s*0084\s*→\s*0085\s*→\s*0086\s*→\s*0087\s*→\s*0141/.test(header));
  ok("0143's header says it depends on 0064", /Depends on 0064/.test(read("0143_support_tickets_ops.sql").slice(0, 3000)));
  const dbDoc = readFileSync(new URL("../../../docs/DATABASE.md", import.meta.url), "utf8");
  ok("docs/DATABASE.md states it too", /0061\s*→\s*0063\s*→\s*0064\s*→\s*0081\s*→\s*0082\s*→\s*0083\s*→\s*0084\s*→\s*0085\s*→\s*0086\s*→\s*0087\s*→\s*0141/.test(dbDoc));
}

console.log("\n── rider support tickets: 0087 opens them to every manager, 0143 scopes them ──");
{
  const m0087 = read("0087_support_notifications.sql");
  const m0143 = read("0143_support_tickets_ops.sql");
  const opens = /create policy "support_tickets — manager rider read"/.test(m0087);
  ok("0143 drops 0087's \"manager rider read\" policies (they would OR past the zone reads)",
    !opens || (/drop policy if exists "support_tickets — manager rider read"/.test(m0143)
      && /drop policy if exists "support_messages — manager rider read"/.test(m0143)));
  ok("...so 0087 must be applied before 0143 — the stated order says so",
    /0087\s*→\s*0141/.test(read("0141_manager_foundation.sql")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
