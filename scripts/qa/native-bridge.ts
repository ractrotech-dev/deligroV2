/**
 * QA — the web app detects the Android shell and reaches its push plugin,
 * and behaves exactly as before in a normal browser.
 * Usage: npx tsx scripts/qa/native-bridge.ts
 */
import { isNativeApp, missingRingSettings, nativePush, nativeRing, nativeSessionSync, pushSupport, ringDiff } from "../../src/lib/native/bridge";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const plugin = { login: async () => {}, logout: async () => {}, requestPermission: async () => {} };
const shell = { Capacitor: { isNativePlatform: () => true, Plugins: { DeligroPush: plugin } } };
const browser = {};
const webCapacitor = { Capacitor: { isNativePlatform: () => false, Plugins: {} } };
const shellWithoutPlugin = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };

check("shell is native", isNativeApp(shell as never));
check("plain browser is not native", !isNativeApp(browser as never));
check("Capacitor web build is not native", !isNativeApp(webCapacitor as never));
check("undefined window (server render) is not native", !isNativeApp(undefined));
check("shell exposes the push plugin", nativePush(shell as never) === plugin);
check("browser has no push plugin", nativePush(browser as never) === null);
check("an old shell without the plugin returns null, not a crash", nativePush(shellWithoutPlugin as never) === null);

// Signing in on a phone: ties the device to the user AND asks Android 13+
// for notification permission once (no settings nag).
const calls: string[] = [];
const recorder = {
  login: (o: { userId: string }) => { calls.push(`login:${o.userId}`); return Promise.resolve(); },
  logout: () => { calls.push("logout"); return Promise.resolve(); },
  requestPermission: (o?: { fallbackToSettings?: boolean }) => { calls.push(`perm:${o?.fallbackToSettings}`); return Promise.resolve(); },
};

async function main() {
  await nativeSessionSync(recorder, "u1");
  check("signed in: login then a quiet permission request", calls.join(",") === "login:u1,perm:false");
  calls.length = 0;
  await nativeSessionSync(recorder, null);
  check("signed out: logout only (shared phone stops getting pushes)", calls.join(",") === "logout");

  check("push support in the Android shell is native", pushSupport(shell as never) === "native");
  check("push support in a browser with Notification is web", pushSupport({ Notification: function () {} } as never) === "web");
  check("push support with neither is unsupported", pushSupport({} as never) === "unsupported");

  // --- ringing (Vendor/Rider ≥ 1.1.0) ---
  const ringPlugin = { ...plugin, startRing: async () => {}, stopRing: async () => {}, ringSetup: () => Promise.resolve({ notifications: true, fullScreen: true, batteryUnrestricted: true }), openRingSettings: async () => {} };
  const ringShell = { Capacitor: { isNativePlatform: () => true, Plugins: { DeligroPush: ringPlugin } } };
  check("new APK exposes the ring", nativeRing(ringShell as never) === ringPlugin);
  check("old APK (no stopRing) has no ring", nativeRing(shell as never) === null);
  check("browser has no ring", nativeRing(browser as never) === null);
  check("server render has no ring", nativeRing(undefined) === null);
  const d = ringDiff(["a", "b"], ["b", "c"]);
  check("ringDiff starts new ids", d.started.join() === "c");
  check("ringDiff stops departed ids", d.stopped.join() === "a");
  const same = ringDiff(["a"], ["a"]);
  check("ringDiff with no change does nothing", same.started.length === 0 && same.stopped.length === 0);
  const all = { notifications: true, fullScreen: true, batteryUnrestricted: true, manufacturer: "samsung" };
  check("fully set-up phone needs nothing", missingRingSettings(all).length === 0);
  check("battery saver on is flagged", missingRingSettings({ ...all, batteryUnrestricted: false }).join() === "battery");
  check("notifications off comes first", missingRingSettings({ notifications: false, fullScreen: false, batteryUnrestricted: false }).join() === "notifications,battery,fullScreen");
  const redmi = { ...all, manufacturer: "Xiaomi" };
  check("Xiaomi keeps an Autostart step even with everything else fixed", missingRingSettings(redmi).join() === "autostart");
  check("Vivo / Oppo / Realme too", ["vivo", "OPPO", "realme"].every((m) => missingRingSettings({ ...all, manufacturer: m }).includes("autostart")));
  check("Autostart goes once acknowledged", missingRingSettings(redmi, { autostartDone: true }).length === 0);
  check("Samsung has no Autostart step", !missingRingSettings(all).includes("autostart"));
  const first = ringDiff([], ["a", "b"]);
  check("first look rings for everything already waiting", first.started.join() === "a,b" && first.stopped.length === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
void main();
