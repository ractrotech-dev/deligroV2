/**
 * QA — the dashboard and statistics routes after Phase 2 review finding 1/4:
 * the short shared cache, and the per-user read budget on both routes.
 * Offline. Usage: npx tsx scripts/qa/manager-rollup-routes.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cached, clearServerCache, scopeCacheKey } from "../../src/lib/server-cache";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

async function main() {
  console.log("── server cache ──");
  clearServerCache();
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 5));
    return loads;
  };
  const [a, b] = await Promise.all([cached("k", 1000, load), cached("k", 1000, load)]);
  ok("a burst of identical requests shares one load", loads === 1 && a === 1 && b === 1, { loads });
  ok("a fresh entry is served from memory", (await cached("k", 1000, load)) === 1 && loads === 1);
  await cached("k2", 1000, load);
  ok("another key loads separately", loads === 2);

  let failing = 0;
  const bad = async () => {
    failing++;
    throw new Error("boom");
  };
  await cached("bad", 1000, bad).catch(() => null);
  await cached("bad", 1000, bad).catch(() => null);
  ok("a failed load is never cached", failing === 2, { failing });

  clearServerCache();
  await cached("ttl", 1, load);
  await new Promise((r) => setTimeout(r, 10));
  const before = loads;
  await cached("ttl", 1, load);
  ok("an expired entry reloads", loads === before + 1);

  ok("scope keys: all", scopeCacheKey(null) === "all");
  ok("scope keys: order-independent", scopeCacheKey(["b", "a"]) === scopeCacheKey(["a", "b"]));
  ok("scope keys: different zones never share", scopeCacheKey(["a"]) !== scopeCacheKey(["a", "b"]));
  ok("scope keys: no zones is its own key", scopeCacheKey([]) === "none" && scopeCacheKey([]) !== scopeCacheKey(null));

  console.log("\n── routes ──");
  const route = (p: string) => readFileSync(join(__dirname, "..", "..", "src/app/api/manager", p, "route.ts"), "utf8");
  const dash = route("dashboard");
  const stats = route("stats");
  ok("dashboard is rate-limited per user", /rateLimit\(`manager-dashboard:\$\{ctx\.profile\.id\}`/.test(dash));
  ok("stats is rate-limited per user", /rateLimit\(`manager-stats:\$\{ctx\.profile\.id\}`/.test(stats));
  ok("the limit is checked after authorisation", dash.indexOf("managerApiContext(") < dash.indexOf("rateLimit(") &&
    stats.indexOf("managerApiContext(") < stats.indexOf("rateLimit("));
  ok("dashboard reads the rollup", dash.includes("loadDashboard(scope, now)") && !dash.includes("loadMetricOrders"));
  ok("stats reads the rollups", stats.includes("loadStatsRollups(") && !stats.includes("loadMetricOrders"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
