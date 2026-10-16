/**
 * QA — the handover-code readers work before AND after migration 0058.
 *
 * Before: the functions do not exist, the columns are readable -> fall back.
 * After:  the functions exist, the columns are not readable    -> use the functions.
 * Any OTHER error must surface, not trigger a fallback that would fail again.
 * Offline. Usage:  npm run test:rpc-fallback
 */
import { isMissingFunction, preferRpc, type FallbackState, type Reply } from "../../src/lib/data-access/rpc-fallback";

let failed = 0, passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

const hit = (data: string | null): Reply<string> => ({ data, error: null });
const fail = (code: string): Reply<string> => ({ data: null, error: { code } });

async function main() {
  check("PGRST202 is a missing function", isMissingFunction({ code: "PGRST202" }));
  check("42883 is a missing function", isMissingFunction({ code: "42883" }));
  check("42501 (permission denied) is not", !isMissingFunction({ code: "42501" }));
  check("a null error is not", !isMissingFunction(null));

  // AFTER 0058: function works; the table must never be touched.
  {
    const state: FallbackState = { missing: false };
    let tableCalls = 0;
    const r = await preferRpc(state, () => Promise.resolve(hit("8765")), () => { tableCalls++; return Promise.resolve(hit("WRONG")); });
    check("function present: its answer is used", r.data === "8765");
    check("function present: the table is never read", tableCalls === 0);
  }
  // BEFORE 0058: function missing -> fall back once, then remember.
  {
    const state: FallbackState = { missing: false };
    let rpcCalls = 0, tableCalls = 0;
    const viaRpc = () => { rpcCalls++; return Promise.resolve(fail("PGRST202")); };
    const viaTable = () => { tableCalls++; return Promise.resolve(hit("8765")); };
    const r1 = await preferRpc(state, viaRpc, viaTable);
    check("function missing: falls back to the table", r1.data === "8765" && tableCalls === 1);
    check("...and remembers it", state.missing === true);
    const r2 = await preferRpc(state, viaRpc, viaTable);
    check("second call does not ask the missing function again", rpcCalls === 1 && tableCalls === 2 && r2.data === "8765", { rpcCalls, tableCalls });
  }
  // Any other error surfaces.
  {
    const state: FallbackState = { missing: false };
    let tableCalls = 0;
    const r = await preferRpc(state, () => Promise.resolve(fail("42501")), () => { tableCalls++; return Promise.resolve(hit("x")); });
    check("permission denied is returned, not papered over", r.error?.code === "42501" && tableCalls === 0);
    check("...and does not mark the function missing", state.missing === false);
  }
  // A genuine "no row" from the function is an answer, not a reason to fall back.
  {
    const state: FallbackState = { missing: false };
    let tableCalls = 0;
    const r = await preferRpc(state, () => Promise.resolve(hit(null)), () => { tableCalls++; return Promise.resolve(hit("leak")); });
    check("null from the function (not your order) stays null", r.data === null && tableCalls === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
