/**
 * QA — Phase 2 review finding 14: telling "this database function is not there
 * yet" apart from "the call failed", in the sessions and password routes and
 * the feature-switch writer. Offline. Usage: npx tsx scripts/qa/manager-rpc-errors.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRpcMissing, unauditedFallbackAllowed } from "../../src/lib/manager/rpc-errors";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

console.log("── classification ──");
ok("PostgREST: no such function", isRpcMissing({ code: "PGRST202" }));
ok("Postgres: undefined function", isRpcMissing({ code: "42883" }));
ok("Postgres: owner may not reach auth.sessions", isRpcMissing({ code: "42501" }));
ok("a timeout is a failure, not 'missing'", !isRpcMissing({ code: "57014" }));
ok("a raised business error is a failure", !isRpcMissing({ code: "22023", message: "no_session_claim" }));
ok("no error is not missing", !isRpcMissing(null));

console.log("\n── the unaudited feature-switch fallback ──");
ok("allowed only when the RPC is missing and the audit log does not exist",
  unauditedFallbackAllowed({ code: "PGRST202" }, { code: "42P01" }));
ok("a stale schema cache (RPC 'missing' but the audit log exists) is refused",
  !unauditedFallbackAllowed({ code: "PGRST202" }, null));
ok("a failing audit-log probe is refused (never fail open)",
  !unauditedFallbackAllowed({ code: "PGRST202" }, { code: "57014" }));
ok("any other RPC failure is refused", !unauditedFallbackAllowed({ code: "23505" }, { code: "42P01" }));

console.log("\n── routes ──");
const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
const sessions = read("src/app/api/manager/sessions/route.ts");
ok("sessions: 501 only when the function is missing", /isRpcMissing\(error\)/.test(sessions));
ok("sessions: any other failure is a 500", /sessions_failed/.test(sessions) && /status: 500/.test(sessions));
ok("sessions: a missing session claim is said plainly", /no_session_claim/.test(sessions));
const password = read("src/app/api/manager/password/route.ts");
ok("password: the sign-out-elsewhere result is checked", /error: revokeError/.test(password));
ok("password: the answer says when other devices are still signed in", /other_sessions_still_signed_in/.test(password));
const flags = read("src/lib/features/flags.server.ts");
ok("feature switches: the fallback goes through unauditedFallbackAllowed", /unauditedFallbackAllowed\(/.test(flags));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
