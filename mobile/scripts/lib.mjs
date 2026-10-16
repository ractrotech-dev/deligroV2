/**
 * Pure helpers for the Android shell builds. No I/O here — build-apk.mjs
 * does the file system and process work; this is what the tests pin.
 */

const REQUIRED = ["role", "appId", "appName", "path", "versionCode", "versionName"];

export function loadRoles(json) {
  const cfg = JSON.parse(json);
  if (typeof cfg.baseUrl !== "string" || !cfg.baseUrl.startsWith("https://")) {
    throw new Error("roles.json: baseUrl must be an https:// URL");
  }
  if (!Array.isArray(cfg.roles) || cfg.roles.length === 0) {
    throw new Error("roles.json: roles must be a non-empty array");
  }
  const seen = new Set();
  for (const r of cfg.roles) {
    for (const k of REQUIRED) {
      if (r[k] === undefined || r[k] === "") throw new Error(`roles.json: role ${r.role ?? "?"} is missing ${k}`);
    }
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(r.appId)) {
      throw new Error(`roles.json: invalid appId ${r.appId}`);
    }
    if (r.ring !== undefined && typeof r.ring !== "boolean") {
      throw new Error(`roles.json: role ${r.role} ring must be true or false`);
    }
    if (seen.has(r.appId)) throw new Error(`roles.json: duplicate appId ${r.appId}`);
    seen.add(r.appId);
  }
  return cfg;
}

export function capacitorConfigFor(role, baseUrl, oneSignalAppId) {
  const host = new URL(baseUrl).host;
  const url = new URL(role.path, baseUrl).toString();
  return {
    appId: role.appId,
    appName: role.appName,
    webDir: "www",
    server: {
      url,
      // Only the live site loads inside the app; every other link (Maps,
      // WhatsApp, tel:) is handed to Android.
      allowNavigation: [host],
      cleartext: false,
      androidScheme: "https",
      // Shown from www/ when the site can't be reached.
      errorPath: "offline.html",
    },
    android: {
      allowMixedContent: false,
      appendUserAgent: `DeligroApp/${role.role}`,
      // apksigner gives a v2+ signature. Capacitor's default (jarsigner) is
      // v1-only, which Android 11+ refuses to install for SDK 30+ targets.
      buildOptions: { signingType: "apksigner", releaseType: "APK" },
    },
    plugins: {
      DeligroPush: { oneSignalAppId },
    },
  };
}

export function patchMainActivity(appId) {
  return `package ${appId};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.ractrotech.deligro.push.DeligroPushPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeligroPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
}

const ONESIGNAL_DEP = "    implementation 'com.onesignal:OneSignal:[5.1.0, 5.99.99]'";

export function patchAppGradle(src, versionCode, versionName) {
  let out = src
    .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);
  if (!out.includes("com.onesignal:OneSignal")) {
    out = out.replace(/dependencies\s*\{\n/, (m) => `${m}${ONESIGNAL_DEP}\n`);
  }
  return out;
}

const PERMS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
];

export function patchManifestPermissions(xml) {
  const missing = PERMS.filter((p) => !xml.includes(p));
  if (missing.length === 0) return xml;
  const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");
  return xml.replace(/<\/manifest>\s*$/, `${lines}\n</manifest>\n`);
}

/**
 * argv for `npx cap build android`, as an array so passwords are never
 * re-parsed by a shell (quotes, %VAR%, $, backticks all survive as typed).
 */
export function signedBuildArgs({ keystore, storePass, keyPass, alias }) {
  return [
    "cap", "build", "android",
    "--keystorepath", keystore,
    "--keystorepass", storePass,
    "--keystorealias", alias,
    "--keystorealiaspass", keyPass,
    "--androidreleasetype", "APK",
    "--signing-type", "apksigner",
  ];
}

/** The same argv with the two password values masked, for logging. */
export function redactArgs(args) {
  return args.map((a, i) =>
    i > 0 && (args[i - 1] === "--keystorepass" || args[i - 1] === "--keystorealiaspass") ? "***" : a
  );
}

/**
 * The app's offline page, with Retry pointed at the role's live URL.
 * Capacitor serves errorPath from the local www folder, so a plain reload
 * would only reload the offline page itself.
 */
export function offlinePageFor(html, url) {
  return html.replaceAll("location.reload()", `location.replace(${JSON.stringify(url)})`);
}

const RING_PERMS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.USE_FULL_SCREEN_INTENT",
  "android.permission.VIBRATE",
  "android.permission.WAKE_LOCK",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
];

const RING_APP_ENTRIES = `        <service android:name="com.ractrotech.deligro.push.RingService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
        <meta-data android:name="com.onesignal.NotificationServiceExtension"
            android:value="com.ractrotech.deligro.push.DeligroNotificationExtension" />
`;

/**
 * Vendor + Rider only (roles.json `"ring": true`): the ringing service, the
 * OneSignal extension that starts and stops it, and what they need.
 */
export function patchManifestRing(xml) {
  let out = xml;
  const missing = RING_PERMS.filter((p) => !out.includes(`"${p}"`));
  if (missing.length > 0) {
    const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");
    out = out.replace(/<\/manifest>\s*$/, `${lines}\n</manifest>\n`);
  }
  if (!out.includes("push.RingService")) {
    out = insertBeforeApplicationClose(out, RING_APP_ENTRIES);
  }
  return out;
}

/**
 * `xml.replace(/\n(\s*)<\/application>/, `\n${entries}$1</application>`)`,
 * without the regex: `\n` is also `\s`, so that pattern rescans every blank
 * run once per newline in it. Same result — the entries go after the first
 * newline of the whitespace in front of the first `</application>` that has one.
 */
function insertBeforeApplicationClose(xml, entries) {
  const close = "</application>";
  for (let at = xml.indexOf(close); at !== -1; at = xml.indexOf(close, at + 1)) {
    let start = at;
    while (start > 0 && /\s/.test(xml[start - 1])) start--;
    const nl = xml.indexOf("\n", start);
    if (nl !== -1 && nl < at) return `${xml.slice(0, nl)}\n${entries}${xml.slice(nl + 1)}`;
  }
  return xml;
}

/**
 * The ring: 1.2 s of alternating 880/660 Hz (0.2 s each, 10 ms fades so it
 * doesn't click), then 0.8 s of silence — 2 s, looped by RingService.
 * Generated rather than shipped, so there is no licence question about it.
 */
export function ringWav(rate = 22050) {
  const n = rate * 2;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    if (t < 1.2) {
      const local = t % 0.2;
      const f = Math.floor(t / 0.2) % 2 === 0 ? 880 : 660;
      const env = Math.min(1, local / 0.01, (0.2 - local) / 0.01);
      s = Math.sin(2 * Math.PI * f * t) * 0.8 * env;
    }
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
