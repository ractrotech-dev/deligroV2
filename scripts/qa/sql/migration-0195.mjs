// Proves migration 0195 on the real migration chain (chain-lib.mjs): rider cash goes to a
// manager or to the owner, one confirmation is enough, and who confirmed is recorded.
//
//   1. a manager and the owner both acting on one deposit: the first wins, the second gets
//      already_decided, and there is one handover (both orders of who goes first);
//   2. the owner's confirmation writes rider_to_owner and stays off every manager's balance;
//   3. direct cash, rider → owner and manager → owner, with who confirmed;
//   4. a manager's own "I gave it to the owner" row: unconfirmed, then confirmed once;
//   5. the same cash written down by two people is refused;
//   6. ops_rider_cash_position and ops_cash_reconciliation stay correct, including history;
//   7. only an admin can use the owner functions.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0195.mjs
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

const uuid = (n) => `00000000-0000-4000-8000-0000000195${String(n).padStart(2, "0")}`;
const [ADMIN, MGR, MGR2, R1, R2, R3, R4, CUST, SHOP] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid);
const ZONE = uuid(10);

/** Run as the service role, which is how every server route reaches these functions. */
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
await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into auth.users (id, email) select id, id || '@x.test' from unnest(array['${ADMIN}','${MGR}','${MGR2}','${R1}','${R2}','${R3}','${R4}','${CUST}']::uuid[]) id;
  insert into public.profiles (id, role, full_name) values
    ('${ADMIN}','admin','Owner'), ('${MGR}','manager','Mina'), ('${MGR2}','manager','Mohan'),
    ('${R1}','driver','Ravi'), ('${R2}','driver','Raju'), ('${R3}','driver','Rahul'), ('${R4}','driver','Rohan'), ('${CUST}','customer','C')
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  select set_config('test.jwt','',false);
`);
const [zr] = await one(db, `select public.default_zone_id() as id`);
const zone = zr.id ?? ZONE;
await db.exec(`
  select set_config('test.jwt','{"role":"service_role"}',false);
  insert into public.staff_zones (user_id, zone_id) values
    ('${MGR}','${zone}'), ('${MGR2}','${zone}'), ('${R1}','${zone}'), ('${R2}','${zone}'), ('${R3}','${zone}'), ('${R4}','${zone}')
    on conflict do nothing;
  select set_config('test.jwt','',false);
`);

const declare = async (rider, amount, managerId = null) => {
  const r = await svc(`insert into public.cash_deposits (driver_id, amount, method, manager_id)
    values ('${rider}', ${amount}, 'cash', ${managerId ? `'${managerId}'` : "null"}) returning id`);
  if (!r.ok) throw new Error(r.msg);
  return r.rows[0].id;
};
const decide = (actor, id, decision = "confirm", note = null) =>
  svc(`select public.ops_decide_cash_deposit('${actor}', '${id}', '${decision}', ${note ? `'${note}'` : "null"}, null, null) as r`);
const rows = async (where) => (await db.query(`select leg::text as leg, from_user, to_user, amount, recorded_by, confirmed_by, confirmed_at, note from public.cod_handovers where ${where} order by created_at`)).rows;
const position = async (rider) =>
  (await svc(`select public.ops_rider_cash_position('${rider}', (now() at time zone 'Asia/Kolkata')::date) as p`)).rows[0].p;
const recon = async (rider = null) => {
  const r = await svc(`select public.ops_cash_reconciliation(null, (current_date - 40)::date, (current_date + 2)::date, ${rider ? `'${rider}'` : "null"}) as r`);
  if (!r.ok) throw new Error(r.msg);
  return r.rows[0].r;
};
const record = (actor, from, kind, amount, note = null, cid = null) =>
  svc(`select public.ops_record_cash_received('${actor}', '${from}', '${kind}', ${amount}, ${note ? `'${note}'` : "null"}, ${cid ? `'${cid}'` : "null"}) as r`);

// ---------- 1. one deposit, two people: the first confirmation wins ----------
{
  const id = await declare(R1, 500, MGR);
  const first = await decide(MGR, id);
  ok(first.ok, "a manager confirms a deposit", first.msg);
  const second = await decide(ADMIN, id);
  ok(!second.ok && /already_decided/.test(second.msg), "the owner confirming the same deposit is told already_decided", second.msg ?? "accepted");
  const hs = await rows(`from_user = '${R1}'`);
  ok(hs.length === 1, "and there is one handover, not two", JSON.stringify(hs));
  ok(hs[0].leg === "rider_to_manager" && hs[0].to_user === MGR && hs[0].confirmed_by === MGR, "written to the manager who confirmed", JSON.stringify(hs[0]));
  ok((await position(R1)).deposited_total === 500, "the rider's deposited figure counts it once");

  const id2 = await declare(R2, 700, MGR);
  const owner = await decide(ADMIN, id2);
  ok(owner.ok, "the owner confirms a deposit", owner.msg);
  const manager = await decide(MGR, id2);
  ok(!manager.ok && /already_decided/.test(manager.msg), "the manager confirming it afterwards is told already_decided", manager.msg ?? "accepted");
  const hs2 = await rows(`from_user = '${R2}'`);
  ok(hs2.length === 1 && hs2[0].leg === "rider_to_owner", "one handover, on the rider → owner leg", JSON.stringify(hs2));
  ok(hs2[0].to_user === ADMIN && hs2[0].recorded_by === ADMIN && hs2[0].confirmed_by === ADMIN && hs2[0].confirmed_at, "recorded with who confirmed", JSON.stringify(hs2[0]));

  const d = await one(db, `select status, decided_by, handover_id from public.cash_deposits where id = '${id2}'`);
  ok(d[0].status === "confirmed" && d[0].decided_by === ADMIN && d[0].handover_id, "the deposit says who decided it", JSON.stringify(d[0]));

  const dis = await declare(R3, 200);
  const disputed = await decide(ADMIN, dis, "dispute", "Amount short");
  ok(disputed.ok, "the owner can dispute a deposit", disputed.msg);
  const after = await decide(MGR, dis);
  ok(!after.ok && /already_decided/.test(after.msg), "and a manager can't then confirm it", after.msg ?? "accepted");
  ok((await position(R3)).deposited_total === 0, "a disputed deposit comes off nothing");
  ok(!(await decide(ADMIN, await declare(R3, 100), "dispute")).ok, "a dispute without a note is refused");
}

// ---------- 2. who holds it, in the rollups ----------
{
  const r = await recon();
  const riderDay = (id) => r.riders.filter((x) => x.riderId === id).reduce((s, x) => s + Number(x.deposited), 0);
  ok(riderDay(R1) === 500, "reconciliation: the rider → manager deposit is deposited", JSON.stringify(r.riders));
  ok(riderDay(R2) === 700, "reconciliation: the rider → owner deposit is deposited too");
  const mine = r.managers.filter((m) => m.managerId === MGR).reduce((s, m) => s + Number(m.received), 0);
  ok(mine === 500, "reconciliation: only the ₹500 the manager received is on the manager", JSON.stringify(r.managers));
  ok(!r.managers.some((m) => m.managerId === ADMIN), "the owner is not listed as a manager holding cash", JSON.stringify(r.managers));
}

// ---------- 3. cash received directly ----------
{
  const r = await record(ADMIN, R4, "rider", 300, "Paid at the office");
  ok(r.ok, "the owner records cash received directly from a rider", r.msg);
  const h = await rows(`from_user = '${R4}'`);
  ok(h.length === 1 && h[0].leg === "rider_to_owner" && h[0].to_user === ADMIN && h[0].confirmed_by === ADMIN, "on the rider → owner leg, confirmed by the owner", JSON.stringify(h));
  ok((await position(R4)).deposited_total === 300, "the rider's figure moves");

  const m = await record(ADMIN, MGR2, "manager", 150);
  ok(m.ok, "the owner records cash received from a manager", m.msg);
  const mh = await rows(`from_user = '${MGR2}'`);
  ok(mh.length === 1 && mh[0].leg === "manager_to_owner" && mh[0].confirmed_by === ADMIN, "on the manager → owner leg, confirmed by the owner", JSON.stringify(mh));
  const rec = await recon();
  ok(rec.managers.filter((x) => x.managerId === MGR2).reduce((s, x) => s + Number(x.handedOn), 0) === 150, "the manager's handed-on figure moves", JSON.stringify(rec.managers));

  ok(!(await record(MGR, R4, "rider", 10)).ok, "a manager can't use it");
  ok(!(await record(ADMIN, R4, "manager", 10)).ok, "a rider can't be recorded as a manager");
  ok(!(await record(ADMIN, MGR, "rider", 10)).ok, "a manager can't be recorded as a rider");
  ok(!(await record(ADMIN, R4, "rider", 0)).ok, "zero is refused");

  const before = (await rows(`from_user = '${R4}'`)).length;
  const a1 = await record(ADMIN, R4, "rider", 45, null, "cid-0195-a");
  const a2 = await record(ADMIN, R4, "rider", 45, null, "cid-0195-a");
  ok(a1.ok && a2.ok && a2.rows[0].r.replayed === true, "a double tap with one action id is a replay", a2.msg);
  ok((await rows(`from_user = '${R4}'`)).length === before + 1, "and writes once");
}

// ---------- 4. a manager's own "I gave it to the owner" ----------
{
  const ins = await svc(`insert into public.cod_handovers (leg, from_user, amount, recorded_by, zone_id)
    values ('manager_to_owner', '${MGR}', 400, '${MGR}', '${zone}') returning id, confirmed_by`);
  ok(ins.ok && ins.rows[0].confirmed_by === null, "a manager's own row waits for the owner", ins.msg);
  const id = ins.rows[0].id;
  const rec = await recon();
  ok(rec.managers.filter((x) => x.managerId === MGR).reduce((s, x) => s + Number(x.handedOn), 0) === 400, "it counts as handed on, as it always has");

  const notAdmin = await svc(`select public.ops_confirm_manager_handover('${MGR}', '${id}', null)`);
  ok(!notAdmin.ok, "the manager can't confirm their own row");
  const c = await svc(`select public.ops_confirm_manager_handover('${ADMIN}', '${id}', null)`);
  ok(c.ok, "the owner confirms it", c.msg);
  const [row] = await rows(`id = '${id}'`);
  ok(row.confirmed_by === ADMIN && row.to_user === ADMIN && row.amount === 400, "confirmed by the owner, no money added", JSON.stringify(row));
  const again = await svc(`select public.ops_confirm_manager_handover('${ADMIN}', '${id}', null)`);
  ok(!again.ok && /already_confirmed/.test(again.msg), "a second confirmation gets already_confirmed", again.msg ?? "accepted");
  const rec2 = await recon();
  ok(rec2.managers.filter((x) => x.managerId === MGR).reduce((s, x) => s + Number(x.handedOn), 0) === 400, "the figure is unchanged");

  const riderLeg = await svc(`select id from public.cod_handovers where leg::text = 'rider_to_owner' limit 1`);
  const wrong = await svc(`select public.ops_confirm_manager_handover('${ADMIN}', '${riderLeg.rows[0].id}', null)`);
  ok(!wrong.ok, "only a manager → owner row can be confirmed this way");

  // A row a manager recorded without from_user: the form has always done this.
  const blank = await svc(`insert into public.cod_handovers (leg, amount, recorded_by, zone_id)
    values ('manager_to_owner', 90, '${MGR2}', '${zone}') returning id`);
  ok(blank.ok, "a manager row with no from_user can be written", blank.msg);
  const rec3 = await recon();
  ok(rec3.managers.filter((x) => x.managerId === MGR2).reduce((s, x) => s + Number(x.handedOn), 0) === 240, "and is counted against whoever recorded it", JSON.stringify(rec3.managers));
}

// ---------- 5. the same cash, written twice by different people ----------
{
  const firstBy = await svc(`insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, zone_id, handover_date)
    values ('rider_to_manager', '${R3}', '${MGR}', 250, '${MGR}', '${zone}', current_date - 3) returning id`);
  ok(firstBy.ok, "a manager writes down cash from a rider", firstBy.msg);
  const dup = await svc(`insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, zone_id, handover_date)
    values ('rider_to_owner', '${R3}', '${ADMIN}', 250, '${ADMIN}', '${zone}', current_date - 3)`);
  ok(!dup.ok && /handover_exists/.test(dup.msg), "the owner writing the same cash for that day is refused", dup.msg ?? "accepted");
  const other = await svc(`insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, zone_id, handover_date)
    values ('rider_to_owner', '${R3}', '${ADMIN}', 260, '${ADMIN}', '${zone}', current_date - 3)`);
  ok(other.ok, "a different amount that day is fine", other.msg);
  const same = await svc(`insert into public.cod_handovers (leg, from_user, to_user, amount, recorded_by, zone_id, handover_date)
    values ('rider_to_manager', '${R3}', '${MGR}', 250, '${MGR}', '${zone}', current_date - 3)`);
  ok(same.ok, "the same person writing it twice stays allowed, as it was", same.msg);

  const dep = await declare(R4, 60);
  const direct = await record(ADMIN, R4, "rider", 61);
  ok(!direct.ok && /deposit_exists/.test(direct.msg), "cash received directly is refused while that rider has a deposit waiting that day", direct.msg ?? "accepted");
  await decide(MGR, dep, "dispute", "Not received");
  const recorded = await record(ADMIN, R4, "rider", 61);
  ok(recorded.ok, "once it is disputed the owner can record the cash", recorded.msg);
  const dep2 = await declare(R4, 5);
  const blocked = await decide(MGR, dep2);
  ok(!blocked.ok && /manual_handover_exists/.test(blocked.msg), "and a later deposit that day can't be confirmed on top of it", blocked.msg ?? "accepted");
  await decide(MGR, dep2, "dispute", "Already recorded");
}

// ---------- 6. history ----------
{
  const hist = await svc(`select count(*)::int as n from public.cod_handovers where confirmed_by is null and leg::text <> 'manager_to_owner'`);
  ok(hist.rows[0].n === 0, "every rider handover has a confirmer");
  const unsure = await svc(`insert into public.cod_handovers (leg, from_user, amount, recorded_by, zone_id)
    values ('rider_to_manager', '${R4}', 1, '${MGR2}', '${zone}') returning confirmed_by`);
  ok(unsure.ok && unsure.rows[0].confirmed_by === MGR2, "a hand-written rider row is stamped with who wrote it", unsure.msg);
}

// ---------- 7. reach ----------
{
  await db.exec(`select set_config('test.uid','${ADMIN}',false); select set_config('test.jwt','{"role":"authenticated","sub":"${ADMIN}"}',false); set role authenticated;`);
  const r = await db.query(`select public.ops_record_cash_received('${ADMIN}', '${R1}', 'rider', 5, null, null)`).then(() => ({ ok: true }), () => ({ ok: false }));
  await db.exec(`reset role; select set_config('test.uid','',false); select set_config('test.jwt','',false);`);
  ok(!r.ok, "a signed-in session can't call the owner functions directly, even an admin's");
}

await db.close();
console.log(fails ? `\n${fails} check(s) failed` : "\nAll 0195 checks passed.");
process.exit(fails ? 1 : 0);
