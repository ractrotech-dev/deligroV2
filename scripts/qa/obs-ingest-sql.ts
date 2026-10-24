/**
 * QA — 0169's obs_ingest in a real (in-process) Postgres: issues are grouped
 * atomically, people per issue are counted once each, signed-out hits are kept
 * apart, a resolved issue that recurs is "regressed", one malformed row does
 * not lose the batch, and the daily counter moves.
 *
 * Loads 0046 (the obs schema) and 0169 into PGlite.
 * Needs: npm i --no-save @electric-sql/pglite@0.2.17
 *   (or NODE_PATH pointing at a folder that has it)
 * Usage: npx tsx scripts/qa/obs-ingest-sql.ts
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}

const read = (f: string) => readFileSync(join(__dirname, "..", "..", "supabase", "migrations", f), "utf8").replace(/\r\n/g, "\n");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const ev = (over: Record<string, unknown> = {}) => ({
  env: "production",
  kind: "error",
  level: "error",
  source: "qa",
  message: "Order not found",
  error_type: "Error",
  error_fingerprint: "fp-1",
  title: "Error: Order not found",
  culprit: "lib/data-access/orders.ts",
  severity: "medium",
  ...over,
});

async function main() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.profiles (id uuid primary key, role text);
  `);
  // 0046 creates every obs_* object; its pg_cron lines are comments.
  await db.exec(read("0046_observability.sql"));
  await db.exec(read("0169_obs_people_and_robust_ingest.sql"));
  await db.exec(read("0170_obs_issue_alerts.sql"));
  await db.exec(read("0171_obs_sign_ins.sql"));

  const ingest = async (events: unknown[]) =>
    (await db.query<{ n: number }>("select public.obs_ingest($1::jsonb) as n", [JSON.stringify(events)])).rows[0].n;
  const issue = async (fp: string) =>
    (await db.query<{ occurrences: string; users_affected: number; status: string }>(
      "select occurrences, users_affected, status from public.obs_issues where fingerprint = $1", [fp])).rows[0];
  const people = async (fp: string) =>
    (await db.query<{ person_key: string; occurrences: string }>(
      "select person_key, occurrences from public.obs_issue_people where fingerprint = $1 order by person_key", [fp])).rows;

  // A hit 3 times, B once, plus 2 signed-out hits, in two batches.
  check("first batch stored", (await ingest([ev({ actor_id: A }), ev({ actor_id: A }), ev({ actor_id: B })])) === 3);
  check("second batch stored", (await ingest([ev({ actor_id: A }), ev(), ev()])) === 3);

  const i1 = await issue("fp-1");
  check("one bug is one issue with the exact count", Number(i1.occurrences) === 6, i1);
  check("people hit counts each signed-in person once", i1.users_affected === 2, i1);
  const p1 = await people("fp-1");
  check("per-person counts are kept, signed-out under 'anonymous'",
    JSON.stringify(p1.map((p) => [p.person_key, Number(p.occurrences)])) === JSON.stringify([[A, 3], [B, 1], ["anonymous", 2]]), p1);

  // A bad row in the middle costs that row only.
  const stored = await ingest([ev({ error_fingerprint: "fp-2" }), ev({ error_fingerprint: "fp-2", actor_id: "not-a-uuid" }), ev({ error_fingerprint: "fp-2" })]);
  check("a malformed row is skipped, not the batch", stored === 2, stored);
  check("…and the issue still counts the good rows", Number((await issue("fp-2")).occurrences) === 2);
  const rejects = (await db.query<{ last_error: string }>("select last_error from public.obs_job_runs where job = 'ingest_rejects'")).rows[0];
  check("…and the skip is recorded where the console can see it", !!rejects && /1 malformed/.test(rejects.last_error), rejects);

  // Regression.
  await db.exec("update public.obs_issues set status = 'resolved' where fingerprint = 'fp-1'");
  await ingest([ev({ actor_id: B })]);
  check("a fixed issue that comes back is 'regressed'", (await issue("fp-1")).status === "regressed");
  check("…and a person already counted is not counted again", (await issue("fp-1")).users_affected === 2);

  // Info rows are stored but never grouped.
  await ingest([ev({ level: "info", error_fingerprint: "fp-info" })]);
  check("info rows make no issue", (await issue("fp-info")) === undefined);

  const daily = (await db.query<{ events: string }>("select events from public.obs_ingest_daily where env = 'production' and day = current_date")).rows[0];
  check("the daily counter adds up every stored row", Number(daily?.events) >= 3 + 3 + 2 + 1 + 1, daily);

  // ---------- alerts (0170) ----------
  const take = async () => (await db.query<{ short_id: string; reason: string; fingerprint: string }>("select * from public.obs_take_alerts(20)")).rows;
  const first = await take();
  check("a new error issue alerts once, however many times it happened",
    first.filter((a) => a.fingerprint === "fp-1" && a.reason === "new").length === 1, first);
  check("…and coming back after being fixed alerts again as 'regressed'",
    first.some((a) => a.fingerprint === "fp-1" && a.reason === "regressed"), first);
  check("an alert is handed out only once", (await take()).length === 0);
  await ingest([ev({ error_fingerprint: "fp-warn", level: "warn" })]);
  await ingest([ev({ error_fingerprint: "fp-dev", env: "development" })]);
  check("a warning, or a laptop's error, does not alert anyone", (await take()).length === 0);

  // ---------- sign-ins (0171) ----------
  await db.query("insert into public.profiles (id, role) values ($1, 'customer')", [A]);
  const signIn = async (outcome: string, device: string | null, country: string | null, actor: string | null = A) =>
    (await db.query<{ r: { new_device: boolean; new_country: boolean } }>(
      "select public.obs_record_sign_in('production','otp',$1,$2,$3,'3210',$4,$5) as r",
      [outcome, outcome === "failure" ? "invalid" : null, actor, device, country])).rows[0].r;
  const s1 = await signIn("success", "Chrome on Android", "IN");
  check("a person's first sign-in is never 'new'", !s1.new_device && !s1.new_country, s1);
  const s2 = await signIn("success", "Chrome on Android", "IN");
  check("the same phone and country again is not new", !s2.new_device && !s2.new_country, s2);
  const s3 = await signIn("success", "Safari on iPhone", "AE");
  check("a different phone or country is flagged new", s3.new_device && s3.new_country, s3);
  await signIn("failure", "Firefox on Windows", "IN");
  const rows = (await db.query<{ outcome: string; actor_role: string; phone_tail: string; new_device: boolean }>(
    "select outcome, actor_role, phone_tail, new_device from public.obs_sign_ins order by id")).rows;
  check("every attempt is kept, with the account's role and only the last four digits",
    rows.length === 4 && rows[3].outcome === "failure" && rows[0].actor_role === "customer" && rows.every((r) => r.phone_tail === "3210"), rows);
  check("a failed attempt never marks a device as known or new",
    rows[3].new_device === false &&
    Number((await db.query<{ n: number }>("select count(*)::int as n from public.obs_known_devices where value = 'Firefox on Windows'")).rows[0].n) === 0);

  // Deleting an issue (retention) takes its people with it.
  await db.exec("delete from public.obs_issues where fingerprint = 'fp-1'");
  check("an issue's people go with it", (await people("fp-1")).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
