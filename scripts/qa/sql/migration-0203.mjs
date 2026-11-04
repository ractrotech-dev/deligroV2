// Proves migration 0203 on the real migration chain: an admin's sessions can be ended by
// another admin, never by themselves, and never by anyone else.
//
// Needs: npm i --no-save @electric-sql/pglite@0.2.17     Usage: node scripts/qa/sql/migration-0203.mjs
import { freshChain, one as rows } from "./chain-lib.mjs";

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

const uuid = (n) => `00000000-0000-4000-8000-0000000203${String(n).padStart(2, "0")}`;
const [ADMIN, ADMIN2, MGR, CUST] = [1, 2, 3, 4].map(uuid);

await db.exec(`select set_config('test.jwt','{"role":"service_role"}',false);`);
await db.exec(`
  insert into auth.users (id, email) select id, id || '@x.test' from unnest(array['${ADMIN}','${ADMIN2}','${MGR}','${CUST}']::uuid[]) id;
  insert into public.profiles (id, role, full_name) values
    ('${ADMIN}','admin','A'), ('${ADMIN2}','admin','B'), ('${MGR}','manager','M'), ('${CUST}','customer','C')
    on conflict (id) do update set role = excluded.role;
  insert into auth.sessions (user_id) values ('${ADMIN2}'), ('${ADMIN2}'), ('${ADMIN}'), ('${CUST}');
`);

const end = async (actor, user) => {
  try {
    return (await rows(db, `select public.ops_revoke_staff_sessions('${actor}','${user}') as n`))[0].n;
  } catch (e) {
    return String(e.message);
  }
};
const left = async (user) => (await rows(db, `select count(*)::int n from auth.sessions where user_id = '${user}'`))[0].n;

ok((await end(ADMIN, ADMIN2)) === 2, "an admin ends another admin's sessions");
ok((await left(ADMIN2)) === 0, "...and they are gone");
ok((await end(ADMIN, ADMIN)) === "forbidden", "an admin can't end their own this way");
ok((await left(ADMIN)) === 1, "...and keeps them");
ok((await end(ADMIN, CUST)) === "forbidden", "a customer's are refused");
ok((await left(CUST)) === 1, "...and kept");
ok((await end(MGR, ADMIN)) === "forbidden", "a manager can't end an admin's");

await db.exec(`select set_config('test.uid','${ADMIN}',false); select set_config('test.jwt','{"role":"authenticated","sub":"${ADMIN}"}',false); set role authenticated;`);
let denied = "";
try {
  await db.query(`select public.ops_revoke_staff_sessions('${ADMIN}','${ADMIN2}')`);
} catch (e) {
  denied = String(e.message);
}
await db.exec(`reset role;`);
ok(/permission denied/.test(denied), "a session can't call it, even an admin's", denied);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
