import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build-apk.mjs");
const FULL_ENV = {
  NEXT_PUBLIC_ONESIGNAL_APP_ID: "x",
  DELIGRO_KEYSTORE: "k.jks",
  DELIGRO_KEYSTORE_PASSWORD: "p",
  DELIGRO_KEY_PASSWORD: "p",
};

function runScript(args, env) {
  const clean = { ...process.env };
  for (const k of Object.keys(FULL_ENV)) delete clean[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env }, encoding: "utf8" });
}

test("no role argument prints usage and exits 1", () => {
  const r = runScript([], FULL_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test("missing signing env refuses to build", () => {
  const { DELIGRO_KEYSTORE, ...rest } = FULL_ENV;
  void DELIGRO_KEYSTORE;
  const r = runScript(["rider"], rest);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing env DELIGRO_KEYSTORE/);
});

test("unknown role is refused before anything is built", () => {
  const r = runScript(["nope"], FULL_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown role nope/);
});

test("the rider is a Flutter app: asking for its Capacitor shell is refused", () => {
  const r = runScript(["rider"], FULL_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rider is a Flutter app now: build it from apps\/rider/);
});
