/**
 * QA — the alert engine's orchestration (Phase 8 review fixes #3, #5, #8, #21).
 *
 * The evaluator is proven in manager-alerts.ts; this proves how a run uses the
 * database: raises batched into a few calls, one shared audience directory,
 * clears that spare what a run did not see, kinds that must not vanish, kinds
 * whose facts were cut short or unavailable left alone, a time budget so a
 * sweep cannot outlast its lease, the lease handed back, errors reported.
 *
 * Fake database and clock — no I/O. Usage: npx tsx --conditions=react-server scripts/qa/manager-alerts-engine.ts
 */
import { evaluateAlerts, type EngineDeps } from "../../src/lib/ops/alerts/engine";
import { ALERT_KINDS, type OpsAlertKind, type ResolvedRule } from "../../src/lib/ops/alerts/catalog";
import { emptyFacts } from "../../src/lib/ops/alerts/evaluate";
import type { LoadedFacts } from "../../src/lib/ops/alerts/facts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-10-22T08:00:00.000Z");
const ZA = "11111111-1111-4111-8111-111111111111";
const rules: ResolvedRule[] = ALERT_KINDS.map((k) => ({
  kind: k.kind, zoneId: null, enabled: k.evaluated !== "phase9", threshold: k.defaultThreshold, windowMinutes: k.defaultWindowMinutes,
}));

type Call = { name: string; args: Record<string, unknown>; at: number };

function harness(opts: {
  facts?: Partial<LoadedFacts>;
  clockSteps?: number[];
  failRaiseFor?: string;
  claims?: Record<string, boolean>;
  loadFactsThrows?: boolean;
} = {}) {
  const calls: Call[] = [];
  const captured: { source: string; attrs?: Record<string, unknown> }[] = [];
  const notified: { audience: unknown; directory: unknown; alertId: unknown }[] = [];
  let tick = 0;
  const steps = opts.clockSteps ?? [];
  const clock = () => {
    const t = 1_000_000 + (steps[tick] ?? steps[steps.length - 1] ?? 0);
    tick += 1;
    return t;
  };
  const directory = { id: "the-one-directory" };
  const deps: EngineDeps = {
    db: {
      async rpc(name, args = {}) {
        calls.push({ name, args, at: calls.length });
        if (name === "ops_claim_alert_run") {
          const key = String(args.p_name);
          return { data: opts.claims?.[key] ?? (key === "prune" ? false : true), error: null };
        }
        if (name === "ops_raise_alerts") {
          const items = args.p_items as { dedupeKey: string }[];
          return {
            data: items.map((it, i) =>
              opts.failRaiseFor && it.dedupeKey === opts.failRaiseFor
                ? { dedupeKey: it.dedupeKey, error: "boom" }
                : { dedupeKey: it.dedupeKey, id: `id-${it.dedupeKey}`, push: i % 2 === 0 }),
            error: null,
          };
        }
        if (name === "ops_clear_alerts") return { data: 0, error: null };
        return { data: null, error: null };
      },
    },
    loadRules: async () => rules,
    loadFacts: async () => {
      if (opts.loadFactsThrows) throw new Error("facts exploded");
      return { ...emptyFacts(NOW), zones: [{ id: ZA, name: "Bemetara" }], unavailable: [], partial: [], ...opts.facts } as LoadedFacts;
    },
    notify: async (audience, _text, data, o) => {
      notified.push({ audience, directory: (o as { directory?: unknown } | undefined)?.directory, alertId: (data as { alertId?: string }).alertId });
      return { inbox: 1, pushed: 1 };
    },
    directory: () => directory as never,
    clock,
    capture: (_e, ctx) => { captured.push({ source: ctx.source, attrs: ctx.attrs }); },
  };
  return { deps, calls, captured, notified, directory };
}

// Enough idle riders that waiting orders are not also a rider shortage.
const idleRiders = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, zoneIds: [ZA], online: true, onBreak: false, activeDeliveries: 0 }));
const waiting = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `o${i}`, code: `O${i}`, zoneId: ZA, status: "ready" as const, vendorName: "Spice Hub", createdAt: NOW.toISOString(),
    lastChangeAt: NOW.toISOString(), acceptWaitMinutes: null, unassignedMinutes: 6, lateByMinutes: null, hasRider: false,
  }));
const named = (calls: Call[], n: string) => calls.filter((c) => c.name === n);

async function main() {
console.log("\n── raises are batched (review #3) ──");
{
  const h = harness({ facts: { orders: waiting(450), riders: idleRiders(400) } });
  const res = await evaluateAlerts(NOW, h.deps);
  check("450 conditions → 3 batched calls, none one-by-one",
    named(h.calls, "ops_raise_alerts").length === 3 && named(h.calls, "ops_raise_alert").length === 0,
    JSON.stringify(h.calls.map((c) => c.name)));
  check("...each batch carries at most 200 items", named(h.calls, "ops_raise_alerts").every((c) => (c.args.p_items as unknown[]).length <= 200));
  check("...and the run reports what it raised", !("skipped" in res) && res.raised === 450, JSON.stringify(res));
  const pushedIds = named(h.calls, "ops_mark_alerts_pushed").flatMap((c) => c.args.p_ids as string[]);
  check("pushes are marked in one call for exactly the alerts the database said to push",
    named(h.calls, "ops_mark_alerts_pushed").length === 1 && pushedIds.length === 225 && h.notified.length === 225, `${pushedIds.length}/${h.notified.length}`);
  check("every notification shares ONE audience directory (staff, zones and switches are read once per run)",
    h.notified.length > 0 && h.notified.every((n) => n.directory === h.directory));
}

console.log("\n── clears spare what the run did not see (review #5, #21) ──");
{
  const h = harness({
    facts: {
      orders: waiting(1),
      riders: idleRiders(2),
      failed: [{ deliveryId: "dl1", orderId: "o1", orderCode: "O1", zoneId: ZA, vendorName: "Spice Hub", riderName: null }],
      cashDays: [{ zoneId: ZA, riderId: "d1", riderName: "Ravi", day: "2026-10-21", collected: 1500, deposited: 0, disputed: true, hoursSinceDayEnd: 1 }],
    },
    clockSteps: [0, 10, 20, 30],
  });
  await evaluateAlerts(NOW, h.deps);
  const clears = named(h.calls, "ops_clear_alerts");
  const firstRaiseAt = named(h.calls, "ops_raise_alerts")[0]?.at ?? 0;
  check("every swept kind is cleared once, after its own raises", clears.length === ALERT_KINDS.filter((k) => k.evaluated === "sweep" || k.evaluated === "both").length);
  check("each clear carries the run's start (so alerts raised after it are spared)",
    clears.every((c) => typeof c.args.p_run_start === "string" && !Number.isNaN(Date.parse(String(c.args.p_run_start)))));
  const unassignedClear = clears.find((c) => c.args.p_kind === "order_unassigned");
  check("...taken a few seconds before the run began, and a kind is cleared only after its own raises",
    clears.every((c) => Date.parse(String(c.args.p_run_start)) <= 1_000_000 - 1) && !!unassignedClear && unassignedClear.at > firstRaiseAt);
  const sticky = clears.filter((c) => c.args.p_keep_unacknowledged === true).map((c) => c.args.p_kind).sort().join(",");
  check("only a failed delivery and a cash gap keep their unacknowledged alerts (review #21)", sticky === "cash_discrepancy,delivery_failed", sticky);
}

console.log("\n── cut-short and unavailable facts never clear (review #8) ──");
{
  const h = harness({
    facts: { orders: waiting(2), unavailable: ["rider_shortage" as OpsAlertKind], partial: ["order_unassigned" as OpsAlertKind] },
  });
  await evaluateAlerts(NOW, h.deps);
  const clearedKinds = named(h.calls, "ops_clear_alerts").map((c) => c.args.p_kind);
  check("a kind whose facts were cut short is raised but not cleared",
    !clearedKinds.includes("order_unassigned") && named(h.calls, "ops_raise_alerts").some((c) => (c.args.p_items as { kind: string }[]).some((i) => i.kind === "order_unassigned")));
  check("a kind whose facts could not be read is neither raised nor cleared", !clearedKinds.includes("rider_shortage"));
  check("every other swept kind is still cleared", clearedKinds.includes("delivery_delayed") && clearedKinds.includes("rider_inactive"));
}

console.log("\n── a run has a time budget (review #3) ──");
{
  // The clock jumps past the budget after the first few reads.
  const h = harness({ facts: { orders: waiting(3) }, clockSteps: [0, 1_000, 2_000, 95_000, 96_000, 97_000, 98_000, 99_000, 100_000, 101_000, 102_000, 103_000, 104_000, 105_000, 106_000, 107_000, 108_000, 109_000, 110_000] });
  const res = await evaluateAlerts(NOW, h.deps);
  check("kinds left over when the budget is spent are deferred, not cleared",
    !("skipped" in res) && Array.isArray(res.deferred) && res.deferred.length > 0 && named(h.calls, "ops_clear_alerts").length < 11,
    JSON.stringify(res));
  check("the lease is still handed back", named(h.calls, "ops_release_alert_run").length === 1);
}

console.log("\n── the lease ──");
{
  const h = harness({ claims: { evaluate: false } });
  const res = await evaluateAlerts(NOW, h.deps);
  check("another run holds it → skipped, and nothing released that is not ours",
    "skipped" in res && res.skipped === "lease" && named(h.calls, "ops_release_alert_run").length === 0 && named(h.calls, "ops_raise_alerts").length === 0);
  const g = harness({ loadFactsThrows: true });
  let threw = false;
  try { await evaluateAlerts(NOW, g.deps); } catch { threw = true; }
  check("a failure while loading facts is raised to the caller and the lease is handed back", threw && named(g.calls, "ops_release_alert_run").length === 1);
}

console.log("\n── errors are reported, not swallowed (review #8) ──");
{
  const h = harness({ facts: { orders: waiting(3), riders: idleRiders(3) }, failRaiseFor: "order_unassigned:o1" });
  const res = await evaluateAlerts(NOW, h.deps);
  check("one bad item is captured with its kind; the rest are raised", h.captured.some((c) => c.source === "alerts/raise") && !("skipped" in res) && res.raised === 2, JSON.stringify([res, h.captured]));
}

console.log("\n── retention ──");
{
  const h = harness({ claims: { prune: true } });
  await evaluateAlerts(NOW, h.deps);
  const prune = named(h.calls, "ops_prune_alerts");
  check("once a day the run prunes alerts resolved over 180 days ago", prune.length === 1 && prune[0].args.p_days === 180);
  const g = harness({ claims: { prune: false } });
  await evaluateAlerts(NOW, g.deps);
  check("...and not on the other runs", named(g.calls, "ops_prune_alerts").length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
