// Proves migration 0196 on the real migration chain (chain-lib.mjs): riders get a fixed
// salary only, and nothing awards an incentive or a bonus any more.
//
//   1. the award trigger and its function are gone;
//   2. a new bonus entry is refused, and salary, adjustment and deduction are not;
//   3. an old bonus row stays readable, still counts as owed, and is not refused when paid;
//   4. no rule is left on, and old rules stay on record.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0196.mjs
import { freshChain, one } from "./chain-lib.mjs";

let fails = 0;
const ok = (c, m, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

const { db, err } = await freshChain();
if (err) {
  console.log(`FAIL the migration chain does not apply: ${err}`);
  process.exit(1);
}

const uuid = (n) => `00000000-0000-4000-8000-0000000196${String(n).padStart(2, "0")}`;
const [ADMIN, RIDER] = [1, 2].map(uuid);

async function svc(sql) {
  await db.exec(`select set_config('test.jwt','{"role":"service_role"}',false);`);
  try {
    return { ok: true, rows: (await db.query(sql)).rows };
  } catch (e) {
    return { ok: false, msg: String(e.message) };
  } finally {
    await db.exec(`select set_config('test.jwt','',false);`);
  }
}
const adjust = (kind, amount, id = "") =>
  svc(`insert into public.rider_adjustments (${id ? "id, " : ""}driver_id, kind, amount, reason, effective_on, created_by)
       values (${id ? `'${id}', ` : ""}'${RIDER}', '${kind}', ${amount}, 'test', current_date, '${ADMIN}') returning id`);

await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into auth.users (id, email) values ('${ADMIN}','a96@x.test'), ('${RIDER}','r96@x.test');
  insert into public.profiles (id, role, full_name) values ('${ADMIN}','admin','Owner'), ('${RIDER}','driver','Ravi')
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  select set_config('test.jwt','',false);
`);

// ---------- 1. nothing awards ----------
{
  const [t] = await one(db, `select count(*)::int as n from pg_trigger where tgname = 'award_rider_incentives'`);
  ok(t.n === 0, "the award trigger is gone");
  const [f] = await one(db, `select count(*)::int as n from pg_proc where proname = 'award_rider_incentives'`);
  ok(f.n === 0, "and so is its function");
}

// ---------- 2. new entries ----------
{
  const bonus = await adjust("bonus", 500);
  ok(!bonus.ok && /rider_bonus_retired/.test(bonus.msg), "a new bonus is refused", bonus.msg ?? "accepted");
  ok((await adjust("salary", 15000)).ok, "salary is still accepted");
  ok((await adjust("deduction", 100)).ok, "a deduction is still accepted");
  ok((await adjust("adjustment", -50)).ok, "an adjustment is still accepted");
}

// ---------- 3. old rows ----------
{
  // A row from before 0196: written with the guard out of the way, as history was.
  const OLD = uuid(3);
  await db.exec(`alter table public.rider_adjustments disable trigger refuse_new_rider_bonus;`);
  const old = await adjust("bonus", 700, OLD);
  await db.exec(`alter table public.rider_adjustments enable trigger refuse_new_rider_bonus;`);
  ok(old.ok, "(fixture) a bonus from before the rule", old.msg);

  const rows = await svc(`select kind::text as kind, amount from public.rider_adjustments where driver_id = '${RIDER}' order by created_at`);
  ok(rows.rows.some((r) => r.kind === "bonus" && Number(r.amount) === 700), "the old bonus stays readable", JSON.stringify(rows.rows));

  const owed = await svc(`select public._rider_payout_preview('${RIDER}', (now() at time zone 'Asia/Kolkata')::date + 1) as n`);
  ok(Number(owed.rows[0].n) === 15000 - 100 - 50 + 700, "and still counts as owed", JSON.stringify(owed.rows));

  const [tg] = await one(db, `select (tgtype & 16) <> 0 as on_update from pg_trigger where tgname = 'refuse_new_rider_bonus'`);
  ok(tg.on_update === false, "the guard fires on insert only, so paying an old bonus is not refused");
}

// ---------- 4. old rules ----------
{
  await db.exec(`alter table public.rider_incentive_rules disable trigger all;`);
  const ins = await svc(`insert into public.rider_incentive_rules (name, period, target_deliveries, bonus_amount, starts_on, active, created_by)
    values ('Old rule', 'daily', 1, 10, current_date - 30, false, '${ADMIN}') returning id`);
  await db.exec(`alter table public.rider_incentive_rules enable trigger all;`);
  ok(ins.ok, "(fixture) an old rule", ins.msg);
  const [n] = await one(db, `select count(*)::int as n from public.rider_incentive_rules where active`);
  ok(n.n === 0, "no rule is left switched on");
  const [c] = await one(db, `select obj_description('public.rider_incentive_awards'::regclass) as d`);
  ok(/Retired by 0196/.test(c.d ?? ""), "the old tables say they are retired", c.d);
}

await db.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nAll 0196 checks passed.");
process.exit(fails ? 1 : 0);
