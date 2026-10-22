#!/usr/bin/env node
/**
 * Build signed Deligro APKs.
 *   node mobile/scripts/build-apk.mjs rider
 *   node mobile/scripts/build-apk.mjs all
 *
 * Env (required): NEXT_PUBLIC_ONESIGNAL_APP_ID, DELIGRO_KEYSTORE,
 *                 DELIGRO_KEYSTORE_PASSWORD, DELIGRO_KEY_PASSWORD
 * The key alias for each app is its role name (see mobile/README.md).
 * Roles marked "build": "flutter" in roles.json (the rider) are not built here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRoles,
  isFlutterRole,
  capacitorConfigFor,
  patchMainActivity,
  patchAppGradle,
  patchManifestPermissions,
  patchManifestRing,
  ringWav,
  signedBuildArgs,
  redactArgs,
  offlinePageFor,
} from "./lib.mjs";

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALIAS_OVERRIDES = {}; // e.g. { customer: "oldCustomerAlias" } from Task 0

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. See mobile/README.md.`);
    process.exit(1);
  }
  return v;
}

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}   (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

function build(role, cfg, env) {
  const appDir = join(MOBILE, "apps", role.role);
  mkdirSync(join(appDir, "www"), { recursive: true });

  // 1. The Capacitor project (package.json + config + web fallback).
  if (!existsSync(join(appDir, "package.json"))) {
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: `deligro-${role.role}`, private: true }, null, 2));
    run("npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/assets --save-exact", appDir);
  }
  writeFileSync(
    join(appDir, "capacitor.config.json"),
    JSON.stringify(capacitorConfigFor(role, cfg.baseUrl, env.oneSignalAppId), null, 2) + "\n"
  );
  // Retry on the offline page goes back to this role's live URL.
  const offline = offlinePageFor(
    readFileSync(join(MOBILE, "native", "offline.html"), "utf8"),
    new URL(role.path, cfg.baseUrl).toString()
  );
  writeFileSync(join(appDir, "www", "offline.html"), offline);
  writeFileSync(join(appDir, "www", "index.html"), offline);

  // 2. The Android project, generated once.
  if (!existsSync(join(appDir, "android"))) run("npx cap add android", appDir);

  // 3. Icons from the site's own icon.
  mkdirSync(join(appDir, "assets"), { recursive: true });
  copyFileSync(join(MOBILE, "..", "public", "icons", "icon-512-maskable.png"), join(appDir, "assets", "icon-only.png"));
  run('npx capacitor-assets generate --android --iconBackgroundColor "#f4f3f0" --splashBackgroundColor "#f4f3f0"', appDir);

  // 4. Native patches: push plugin, MainActivity, gradle, permissions.
  const javaRoot = join(appDir, "android", "app", "src", "main", "java");
  const pluginDir = join(javaRoot, "com", "ractrotech", "deligro", "push");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(join(MOBILE, "native", "DeligroPushPlugin.java"), join(pluginDir, "DeligroPushPlugin.java"));
  // Ringing (lib/alerts/ring.ts). The classes compile into every shell; only
  // `"ring": true` roles declare the service and extension in the manifest.
  for (const f of ["RingService.java", "DeligroNotificationExtension.java"]) {
    copyFileSync(join(MOBILE, "native", f), join(pluginDir, f));
  }
  if (role.ring) {
    const rawDir = join(appDir, "android", "app", "src", "main", "res", "raw");
    mkdirSync(rawDir, { recursive: true });
    // An owner-supplied ring wins over the generated one.
    const custom = ["deligro_ring.mp3", "deligro_ring.wav"].map((f) => join(MOBILE, "native", f)).find(existsSync);
    if (custom) copyFileSync(custom, join(rawDir, custom.endsWith(".mp3") ? "deligro_ring.mp3" : "deligro_ring.wav"));
    else writeFileSync(join(rawDir, "deligro_ring.wav"), ringWav());
  }
  const mainDir = join(javaRoot, ...role.appId.split("."));
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(join(mainDir, "MainActivity.java"), patchMainActivity(role.appId));

  const gradlePath = join(appDir, "android", "app", "build.gradle");
  writeFileSync(gradlePath, patchAppGradle(readFileSync(gradlePath, "utf8"), role.versionCode, role.versionName));

  const manifestPath = join(appDir, "android", "app", "src", "main", "AndroidManifest.xml");
  let manifest = patchManifestPermissions(readFileSync(manifestPath, "utf8"));
  if (role.ring) manifest = patchManifestRing(manifest);
  writeFileSync(manifestPath, manifest);

  // 5. Sync + signed release build.
  run("npx cap sync android", appDir);
  const alias = ALIAS_OVERRIDES[role.role] ?? role.role;
  const args = signedBuildArgs({ keystore: env.keystore, storePass: env.storePass, keyPass: env.keyPass, alias });
  // No shell: passwords are passed as argv entries, never re-parsed, and the
  // log line masks them. The CLI's own script is run with node directly
  // (Windows will not spawn npx.cmd without a shell).
  const capBin = join(appDir, "node_modules", "@capacitor", "cli", "bin", "capacitor");
  console.log(`
$ npx ${redactArgs(args).join(" ")}   (in ${appDir})`);
  const res = spawnSync(process.execPath, [capBin, ...args.slice(1)], { cwd: appDir, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`cap build failed for ${role.role} (exit ${res.status})`);

  // 6. Copy out with a checksum.
  const outDir = join(appDir, "android", "app", "build", "outputs", "apk", "release");
  const signed = ["app-release-signed.apk", "app-release.apk"].map((f) => join(outDir, f)).find(existsSync);
  if (!signed) throw new Error(`No signed APK found in ${outDir}`);
  mkdirSync(join(MOBILE, "dist"), { recursive: true });
  const dest = join(MOBILE, "dist", `deligro-${role.role}-${role.versionName}.apk`);
  copyFileSync(signed, dest);
  const sha = createHash("sha256").update(readFileSync(dest)).digest("hex");
  writeFileSync(`${dest}.sha256`, `${sha}  ${dest.split(/[\\/]/).pop()}\n`);
  console.log(`\nBuilt ${dest}\nsha256 ${sha}`);
}

const which = process.argv[2];
if (!which) {
  console.error("Usage: node mobile/scripts/build-apk.mjs <customer|vendor|rider|manager|all>");
  process.exit(1);
}
const cfg = loadRoles(readFileSync(join(MOBILE, "roles.json"), "utf8"));
const env = {
  oneSignalAppId: need("NEXT_PUBLIC_ONESIGNAL_APP_ID"),
  keystore: need("DELIGRO_KEYSTORE"),
  storePass: need("DELIGRO_KEYSTORE_PASSWORD"),
  keyPass: need("DELIGRO_KEY_PASSWORD"),
};
const targets = which === "all" ? cfg.roles : cfg.roles.filter((r) => r.role === which);
if (targets.length === 0) {
  console.error(`Unknown role ${which}`);
  process.exit(1);
}
// Flutter roles are built from their own folder (apps/<role>/README.md), never
// as a Capacitor shell: asked for by name that is an error, under "all" a skip.
const flutter = targets.filter(isFlutterRole);
for (const role of flutter) {
  const msg = `${role.role} is a Flutter app now: build it from ${role.flutterApp} (see ${role.flutterApp}/README.md).`;
  if (which !== "all") {
    console.error(msg);
    process.exit(1);
  }
  console.log(`Skipping ${msg}`);
}
for (const role of targets) if (!isFlutterRole(role)) build(role, cfg, env);
