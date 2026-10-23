import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadRoles,
  isFlutterRole,
  capacitorConfigFor,
  patchMainActivity,
  patchAppGradle,
  patchManifestPermissions,
  patchManifestRing,
  ringWav,
} from "./lib.mjs";

const good = JSON.stringify({
  baseUrl: "https://deligrodelivery.ractrotech.com",
  oneSignalAppId: "SET_FROM_ENV",
  roles: [
    { role: "rider", appId: "com.ractrotech.deligro.rider", appName: "Deligro Rider", path: "/driver", versionCode: 3, versionName: "1.0.2" },
  ],
});

test("loadRoles accepts a valid file", () => {
  const cfg = loadRoles(good);
  assert.equal(cfg.roles[0].path, "/driver");
});

test("loadRoles rejects http", () => {
  assert.throws(() => loadRoles(good.replace("https://", "http://")), /https/);
});

test("loadRoles rejects duplicate appIds", () => {
  const dup = JSON.parse(good);
  dup.roles.push({ ...dup.roles[0], role: "vendor" });
  assert.throws(() => loadRoles(JSON.stringify(dup)), /duplicate/i);
});

test("loadRoles rejects a role missing a field", () => {
  const bad = JSON.parse(good);
  delete bad.roles[0].appName;
  assert.throws(() => loadRoles(JSON.stringify(bad)), /appName/);
});

test("capacitor config loads the role path on the live host only", () => {
  const cfg = loadRoles(good);
  const cap = capacitorConfigFor(cfg.roles[0], cfg.baseUrl, "os-app-id");
  assert.equal(cap.appId, "com.ractrotech.deligro.rider");
  assert.equal(cap.appName, "Deligro Rider");
  assert.equal(cap.server.url, "https://deligrodelivery.ractrotech.com/driver");
  assert.deepEqual(cap.server.allowNavigation, ["deligrodelivery.ractrotech.com"]);
  assert.equal(cap.server.cleartext, false);
  assert.equal(cap.server.errorPath, "offline.html");
  assert.equal(cap.plugins.DeligroPush.oneSignalAppId, "os-app-id");
  assert.match(cap.android.appendUserAgent, /DeligroApp\/rider/);
});

test("customer path '/' does not produce a double slash", () => {
  const cfg = loadRoles(good);
  const cap = capacitorConfigFor({ ...cfg.roles[0], role: "customer", path: "/" }, cfg.baseUrl, "x");
  assert.equal(cap.server.url, "https://deligrodelivery.ractrotech.com/");
});

test("MainActivity registers the push plugin before super.onCreate", () => {
  const src = patchMainActivity("com.ractrotech.deligro.rider");
  assert.match(src, /^package com\.ractrotech\.deligro\.rider;/);
  assert.ok(src.indexOf("registerPlugin(DeligroPushPlugin.class)") < src.indexOf("super.onCreate"));
});

test("app gradle gets versions and exactly one OneSignal dependency", () => {
  const gradle = `android {\n    defaultConfig {\n        versionCode 1\n        versionName "1.0"\n    }\n}\ndependencies {\n    implementation project(':capacitor-android')\n}\n`;
  const once = patchAppGradle(gradle, 3, "1.0.2");
  const twice = patchAppGradle(once, 3, "1.0.2");
  assert.match(once, /versionCode 3/);
  assert.match(once, /versionName "1\.0\.2"/);
  assert.equal((twice.match(/com\.onesignal:OneSignal/g) ?? []).length, 1);
});

test("manifest gets location permissions exactly once", () => {
  const xml = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n`;
  const twice = patchManifestPermissions(patchManifestPermissions(xml));
  assert.equal((twice.match(/ACCESS_FINE_LOCATION/g) ?? []).length, 1);
  assert.equal((twice.match(/ACCESS_COARSE_LOCATION/g) ?? []).length, 1);
});

// ---- final-review fixes ----
import { offlinePageFor, signedBuildArgs, redactArgs } from "./lib.mjs";

test("APKs are signed with apksigner (v2+), not jarsigner v1-only", () => {
  const cfg = loadRoles(good);
  const cap = capacitorConfigFor(cfg.roles[0], cfg.baseUrl, "x");
  assert.equal(cap.android.buildOptions.signingType, "apksigner");
  assert.equal(cap.android.buildOptions.releaseType, "APK");
});

test("signed build args pass the signing type and keep secrets as separate argv entries", () => {
  const args = signedBuildArgs({ keystore: "C:\k s\r.jks", storePass: 'p"a%s$s', keyPass: "k`p", alias: "rider" });
  assert.deepEqual(args.slice(0, 3), ["cap", "build", "android"]);
  assert.ok(args.includes("--signing-type") && args[args.indexOf("--signing-type") + 1] === "apksigner");
  assert.equal(args[args.indexOf("--keystorepass") + 1], 'p"a%s$s');
  assert.equal(args[args.indexOf("--keystorepath") + 1], "C:\k s\r.jks");
});

test("logged build args never show the passwords", () => {
  const args = signedBuildArgs({ keystore: "k.jks", storePass: "secret1", keyPass: "secret2", alias: "rider" });
  const shown = redactArgs(args).join(" ");
  assert.doesNotMatch(shown, /secret1|secret2/);
  assert.match(shown, /--keystorepass \*\*\*/);
});

test("offline page Retry goes back to the role's live URL, not a local reload", () => {
  const html = '<button type="button" onclick="location.reload()">Try again</button>';
  const out = offlinePageFor(html, "https://deligrodelivery.ractrotech.com/driver");
  assert.doesNotMatch(out, /location\.reload\(\)/);
  assert.match(out, /location\.replace\("https:\/\/deligrodelivery\.ractrotech\.com\/driver"\)/);
});

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="x">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
`;

test("patchManifestRing declares the service, extension and permissions", () => {
  const out = patchManifestRing(MANIFEST);
  assert.match(out, /<service android:name="com\.ractrotech\.deligro\.push\.RingService"[^>]*android:foregroundServiceType="mediaPlayback"/);
  assert.match(out, /com\.onesignal\.NotificationServiceExtension/);
  assert.match(out, /com\.ractrotech\.deligro\.push\.DeligroNotificationExtension/);
  for (const p of ["FOREGROUND_SERVICE", "FOREGROUND_SERVICE_MEDIA_PLAYBACK", "USE_FULL_SCREEN_INTENT", "VIBRATE", "WAKE_LOCK", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"]) {
    assert.ok(out.includes(`android.permission.${p}"`), p);
  }
  assert.ok(out.indexOf("RingService") < out.indexOf("</application>"));
  assert.ok(out.indexOf("RingService") > out.indexOf("<application"));
});

test("patchManifestRing is idempotent", () => {
  const once = patchManifestRing(MANIFEST);
  assert.equal(patchManifestRing(once), once);
});

test("ringWav is a valid 16-bit mono WAV of 2 s", () => {
  const wav = ringWav(8000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8000 * 2 * 2);
  assert.equal(wav.length, 44 + 8000 * 2 * 2);
});

test("ringWav rings then goes quiet (not silence, not a constant tone)", () => {
  const wav = ringWav(8000);
  const at = (sec) => Math.abs(wav.readInt16LE(44 + Math.floor(sec * 8000) * 2));
  let loud = 0;
  for (let t = 0.05; t < 1.15; t += 0.01) loud = Math.max(loud, at(t));
  let quiet = 0;
  for (let t = 1.25; t < 1.99; t += 0.01) quiet = Math.max(quiet, at(t));
  assert.ok(loud > 20000, `loud part peaks at ${loud}`);
  assert.equal(quiet, 0);
});

test("loadRoles accepts a boolean ring flag and rejects anything else", () => {
  const withRing = JSON.parse(good);
  withRing.roles[0].ring = true;
  assert.equal(loadRoles(JSON.stringify(withRing)).roles[0].ring, true);
  withRing.roles[0].ring = "yes";
  assert.throws(() => loadRoles(JSON.stringify(withRing)), /ring/);
});

test("loadRoles accepts a Flutter role with its folder and rejects a bad build value", () => {
  const flutter = JSON.parse(good);
  flutter.roles[0].build = "flutter";
  flutter.roles[0].flutterApp = "apps/rider";
  const role = loadRoles(JSON.stringify(flutter)).roles[0];
  assert.equal(isFlutterRole(role), true);
  delete flutter.roles[0].flutterApp;
  assert.throws(() => loadRoles(JSON.stringify(flutter)), /flutterApp/);
  flutter.roles[0].build = "react-native";
  assert.throws(() => loadRoles(JSON.stringify(flutter)), /build/);
  assert.equal(isFlutterRole(loadRoles(good).roles[0]), false);
});
