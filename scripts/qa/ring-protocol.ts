/**
 * QA — the ring protocol the server sends and the Android apps read.
 * The Java side cannot import TypeScript, so the last block checks the Java
 * sources still name the same keys.
 * Usage: npx tsx scripts/qa/ring-protocol.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ringId, ringStartData, ringStopData, RING_TIMEOUT_SEC, RING_KEYS, vendorRingEnds, staleOfferee } from "../../src/lib/alerts/ring";
import { pushBody } from "../../src/lib/notifications/push-body";
import { HINDI_ENABLED } from "../../src/lib/i18n/lang";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const OID = "3f2a9c1e-0000-4000-8000-000000000001";
const ROOT = join(__dirname, "..", "..");

check("vendor ring id", ringId("vendor", OID) === `vendor:${OID}`);
check("rider ring id", ringId("rider", OID) === `rider:${OID}`);
check("vendor rings at most 5 min", RING_TIMEOUT_SEC.vendor === 300);
check("rider rings for the 3-min offer window", RING_TIMEOUT_SEC.rider === 180);
// Ops ring for a delivery exception, keyed by the EXCEPTION id (one order can raise several).
const XID = "7c1d0e2f-0000-4000-8000-000000000009";
check("ops ring id is ops:<exceptionId>", ringId("ops", XID) === `ops:${XID}`);
check("ops rings at most 5 min", RING_TIMEOUT_SEC.ops === 300);
check("ops ring start/stop carry the same id", ringStartData("ops", XID).ringId === ringStopData("ops", XID).ringId);
// order-events cannot import EXCLUSIVE_OFFER_MS (rider-dispatch imports
// order-events), so the rider timeout is pinned to it here instead.
const dispatch = readFileSync(join(ROOT, "src", "lib", "dispatch", "rider-dispatch.ts"), "utf8");
check(
  "rider timeout equals the exclusive offer window",
  dispatch.includes(`EXCLUSIVE_OFFER_MS = ${RING_TIMEOUT_SEC.rider}_000`),
  "change RING_TIMEOUT_SEC.rider with EXCLUSIVE_OFFER_MS"
);

const start = ringStartData("vendor", OID);
check("start payload", start.ring === "start" && start.ringId === `vendor:${OID}` && start.timeoutSec === 300);
check("start honours a timeout override", ringStartData("rider", OID, 90).timeoutSec === 90);
check("timeout override is clamped to 1..600", ringStartData("rider", OID, 0).timeoutSec === 1 && ringStartData("rider", OID, 9999).timeoutSec === 600);
const before = Date.now();
check("start carries the server time it was sent", typeof start.sentAt === "number" && start.sentAt >= before - 5_000 && start.sentAt <= Date.now());
check("stop carries the server time it was sent", typeof ringStopData("vendor", OID).sentAt === "number");
const stop = ringStopData("rider", OID);
check("stop payload", stop.ring === "stop" && stop.ringId === `rider:${OID}` && !("timeoutSec" in stop));

// --- the OneSignal request body a ring rides on ---
const T = { include_aliases: { external_id: ["p1"] }, target_channel: "push" };
const H = { en: "New order 🔔", hi: "नया ऑर्डर 🔔" };
const M = { en: "Order #3F2A9C1E is waiting.", hi: "ऑर्डर #3F2A9C1E इंतज़ार कर रहा है।" };
// Hindi copy rides the push only while the language switch is on (push-body.ts).
const sameText = (got: unknown, want: { en: string; hi?: string }) =>
  JSON.stringify(got) === JSON.stringify(HINDI_ENABLED ? want : { en: want.en });
const normal = pushBody("app", T, H, M, { url: "/vendor" }, "chan");
check("normal push keeps title, text, url and channel",
  sameText(normal.headings, H) && sameText(normal.contents, M) && normal.url === "/vendor" && normal.android_channel_id === "chan" && !("content_available" in normal));
const ringing = pushBody("app", T, H, M, { priority: 10, ttlSec: 300, data: { ...ringStartData("vendor", OID) } }, "");
check("ring start is high priority with a ttl and the ring data",
  ringing.priority === 10 && ringing.ttl === 300 && (ringing.data as { ring: string }).ring === "start" && sameText(ringing.headings, H));
const silent = pushBody("app", T, { en: "" }, { en: "" }, { silent: true, priority: 10, url: "/vendor", data: { ...ringStopData("vendor", OID) } }, "chan");
check("silent stop shows nothing: no title, text, url or channel",
  !("headings" in silent) && !("contents" in silent) && !("url" in silent) && !("android_channel_id" in silent));
check("silent stop is data-only and still carries the stop", silent.content_available === true && (silent.data as { ring: string }).ring === "stop");
const silentNormal = pushBody("app", T, { en: "" }, { en: "" }, { silent: true, data: { ...ringStopData("vendor", OID) } }, "");
check("silent stop goes to Android only (no web/iOS 'updated in the background' notice)",
  silentNormal.isAndroid === true && silentNormal.isAnyWeb === false && silentNormal.isIos === false);
check("normal push is not platform-filtered", !("isAndroid" in normal) && !("isAnyWeb" in normal));

// --- which status moves end the vendor's ring ---
check("accept ends the vendor ring", vendorRingEnds("placed", "kitchen"));
check("support pushing straight to ready ends it", vendorRingEnds("placed", "ready"));
check("cancel from New ends it", vendorRingEnds("placed", "cancelled"));
check("a move that was never in New does not", !vendorRingEnds("kitchen", "ready"));
check("staying in New does not", !vendorRingEnds("placed", "placed"));

// --- re-offer to a different rider stops the first one ---
check("re-offer to someone else stops the previous rider", staleOfferee("r1", "r2") === "r1");
check("re-offer to the same rider stops nobody", staleOfferee("r1", "r1") === null);
check("first offer stops nobody", staleOfferee(null, "r2") === null && staleOfferee(undefined, "r2") === null);

// --- every server path that ends a ring sends the stop (source pins) ---
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const events = src("src", "lib", "notifications", "order-events.ts");
const assigned = events.slice(events.indexOf("export function notifyDriverAssigned"), events.indexOf("export async function notifyDriverOrderCancelled"));
check("a manager's direct assignment does not ring (nothing to accept, nothing could stop it)", assigned.length > 0 && !assigned.includes("riderRing"));
check("admin status override stops the vendor ring", /vendorRingEnds\(current\.status, status\)[\s\S]{0,80}stopVendorRing/.test(src("src", "app", "admin", "orders", "actions.ts")));
check("manager move stops the vendor ring", /vendorRingEnds\(expected, target\)[\s\S]{0,80}stopVendorRing/.test(src("src", "app", "manager", "actions.ts")));
check("re-offer stops the previous rider's ring", /staleOfferee\([\s\S]{0,200}stopRiderRing/.test(src("src", "lib", "dispatch", "rider-dispatch.ts")));

check("no priority or ttl unless asked", !("priority" in normal) && !("ttl" in normal));

const NATIVE = join(ROOT, "mobile", "native");
const ext = join(NATIVE, "DeligroNotificationExtension.java");
const svc = join(NATIVE, "RingService.java");
if (existsSync(ext) && existsSync(svc)) {
  const javaExt = readFileSync(ext, "utf8");
  for (const k of Object.values(RING_KEYS)) {
    check(`extension reads "${k}"`, javaExt.includes(`"${k}"`));
  }
  check(`extension handles "start"`, javaExt.includes(`"start"`));
  check(`extension handles "stop"`, javaExt.includes(`"stop"`));
  const javaSvc = readFileSync(svc, "utf8");
  check("service plays on the alarm stream", javaSvc.includes("USAGE_ALARM"));
  check("service loops the sound", javaSvc.includes("setLooping(true)"));
  const startBranch = javaExt.slice(javaExt.indexOf('"start".equals(ring)'), javaExt.indexOf('"stop".equals(ring)'));
  check("a refused ring start keeps OneSignal's own notification (preventDefault only after success)",
    startBranch.indexOf("RingService.start(") > -1 && startBranch.indexOf("RingService.start(") < startBranch.indexOf("preventDefault()"));
  check("service stops with its latest startId, never a bare stopSelf()", javaSvc.includes("stopSelfResult(") && !/stopSelf\(\)/.test(javaSvc));
  check("a stop that lands before its start is remembered", javaSvc.includes("deligro_ring_stopped"));
  check("a timed-out ring leaves a 'missed order' notification", javaSvc.includes("deligro_missed"));
  check("start reports whether the service actually started", /static boolean start\(/.test(javaSvc));
} else {
  console.log("  skip Java contract (native files not created yet — Task 3)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
