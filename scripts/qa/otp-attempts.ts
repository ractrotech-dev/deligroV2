/**
 * QA — OTP attempts are spent atomically, and only Indian mobiles get a text.
 *
 * The concurrency case is the point: the old read-compare-write let N parallel
 * wrong guesses cost one attempt. The fake store below yields between read and
 * write the way a network round trip does, which is what exposes that.
 * Offline. Usage:  npm run test:otp-attempts
 */
import { claimAttempt, type AttemptStore } from "../../src/lib/auth/otp-attempts";
import { isIndianMobile, toE164 } from "../../src/lib/auth/phone";

let failed = 0, passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeStore(initial = 0) {
  const row = { attempts: initial, exists: true };
  const store: AttemptStore = {
    async bump(_id, expected) {
      await tick();
      if (!row.exists || row.attempts !== expected) return false;
      row.attempts = expected + 1;
      return true;
    },
    async read() {
      await tick();
      return row.exists ? row.attempts : null;
    },
  };
  return { row, store };
}

async function main() {
console.log("\n── claimAttempt ──");
{
  const { row, store } = fakeStore(0);
  check("a single caller spends one attempt", (await claimAttempt(store, "c1", 0, 5)) === true && row.attempts === 1);
}
{
  const { row, store } = fakeStore(4);
  check("the last attempt can be spent", (await claimAttempt(store, "c1", 4, 5)) === true && row.attempts === 5);
  check("then none is left", (await claimAttempt(store, "c1", 5, 5)) === false && row.attempts === 5);
}
{
  const { row, store } = fakeStore(0);
  const results = await Promise.all(Array.from({ length: 20 }, () => claimAttempt(store, "c1", 0, 5)));
  const won = results.filter(Boolean).length;
  check("20 parallel guesses spend exactly 5 attempts", won === 5 && row.attempts === 5, { won, attempts: row.attempts });
  check("the other 15 never reach the code comparison", results.filter((r) => !r).length === 15);
}
{
  const { row, store } = fakeStore(3);
  const results = await Promise.all(Array.from({ length: 6 }, () => claimAttempt(store, "c1", 3, 5)));
  check("starting at 3, only 2 more are granted", results.filter(Boolean).length === 2 && row.attempts === 5, { attempts: row.attempts });
}
{
  const { row, store } = fakeStore(1);
  row.exists = false;
  check("a code deleted mid-flight is not claimable", (await claimAttempt(store, "c1", 1, 5)) === false);
}

console.log("\n── isIndianMobile ──");
for (const n of ["9876543210", "+919876543210", "09876543210", "919876543210", "6000000000"]) {
  const e = toE164(n);
  check(`${n} is accepted`, e !== null && isIndianMobile(e), e);
}
for (const n of ["+14155552671", "+447911123456", "+971501234567", "+911234567890", "+915876543210", "12345", "+9198765"]) {
  const e = toE164(n);
  check(`${n} gets no SMS`, e === null || !isIndianMobile(e), e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}
main();
