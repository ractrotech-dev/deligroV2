/**
 * QA — the `card` a push carries and the Android renderer that reads it.
 * The Kotlin side cannot import TypeScript, so the last block checks
 * PushStyle.kt still reads every key the server can send.
 * Usage: npx tsx scripts/qa/push-cards.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORDER_STEP, ORDER_STEP_COUNT, orderProgressCard, sanitizeCard, staffCardFor } from "../../src/lib/notifications/push-card";
import { pushBody } from "../../src/lib/notifications/push-body";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const ROOT = join(__dirname, "..", "..");
const OID = "3f2a9c1e-0000-4000-8000-000000000001";

// --- order progress ---
check("order tracker has five steps", ORDER_STEP_COUNT === 5);
check("on the way is step 4", orderProgressCard(ORDER_STEP.onTheWay).steps?.at === 4);
const done = orderProgressCard(ORDER_STEP.delivered, { done: true });
check("delivered draws every step done (at > of) and is green", done.steps?.at === 6 && done.steps.of === 5 && done.tone === "green");

// --- sanitising ---
const messy = sanitizeCard({
  tone: "orange",
  tile: { v: "x".repeat(40), u: "min" },
  steps: { at: 99, of: 99 },
  code: "48a2 1999",
  lines: ["a", "b", "c", "d", "e", "  "],
  stats: [{ v: "1", l: "a" }, { v: "2", l: "b" }, { v: "3", l: "c" }, { v: "4", l: "d" }],
  route: { from: "Shop", to: "" },
});
check("tile value is cut to 12 characters", messy.tile?.v.length === 12);
check("steps are clamped to 6, and at to of + 1", messy.steps?.of === 6 && messy.steps.at === 7);
check("code keeps digits only, at most 4", messy.code === "4821");
check("at most 4 lines, blanks dropped", messy.lines?.length === 4);
check("at most 3 stats", messy.stats?.length === 3);
check("a route without a drop is dropped", messy.route === undefined);
check("an unknown tone is dropped", sanitizeCard({ tone: "pink" as never }).tone === undefined);
check("an empty card sanitises to nothing", Object.keys(sanitizeCard({})).length === 0);
check("zero steps draws no bar", sanitizeCard({ steps: { at: 1, of: 0 } }).steps === undefined);

// --- the push body ---
const body = pushBody("app", { include_aliases: {} }, { en: "T" }, { en: "B" }, { url: "/orders/1", card: orderProgressCard(2), collapseId: `order-${OID}`, data: { orderId: OID } }, "");
const data = body.data as Record<string, unknown>;
check("card travels in data.card beside the other data", !!data.card && data.orderId === OID);
check("title and text are still sent", (body.headings as { en: string }).en === "T" && (body.contents as { en: string }).en === "B");
check("collapse_id is sent", body.collapse_id === `order-${OID}`);
const plain = pushBody("app", {}, { en: "T" }, { en: "B" }, { url: "/x" }, "");
check("a push without a card has no data at all", plain.data === undefined);
const silent = pushBody("app", {}, { en: "" }, { en: "" }, { silent: true, card: { tone: "red" }, collapseId: "x", data: { ring: "stop" } }, "");
check("a silent push never carries a card or collapse id", (silent.data as Record<string, unknown>).card === undefined && silent.collapse_id === undefined);
const emptyCard = pushBody("app", {}, { en: "T" }, { en: "B" }, { card: {} }, "");
check("an empty card adds nothing to data", (emptyCard.data as Record<string, unknown>).card === undefined);

// --- staff colours ---
check("an incident is red", staffCardFor("incident").tone === "red");
check("an unknown staff kind falls back to blue", staffCardFor("something_new").tone === "blue");

// --- the Kotlin renderer reads the same keys ---
const kt = readFileSync(join(ROOT, "apps", "customer", "third_party", "deligro_push_style", "android", "src", "main", "kotlin", "com", "ractrotech", "deligro", "pushstyle", "PushStyle.kt"), "utf8");
for (const key of ["tile", "steps", "code", "route", "lines", "stats", "tone", "fromNote"]) {
  check(`PushStyle.kt reads "${key}"`, kt.includes(`"${key}"`));
}
for (const app of ["customer", "vendor", "rider", "manager"]) {
  const pubspec = readFileSync(join(ROOT, "apps", app, "pubspec.yaml"), "utf8");
  check(`${app} app depends on deligro_push_style`, pubspec.includes("deligro_push_style:"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
