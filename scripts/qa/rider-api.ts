/**
 * QA — /api/rider/* (me, status, location, signout) against a running dev server.
 *
 *   npm run dev            # port 3005
 *   npm run test:rider-api
 *
 *   BASE                       default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD         a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD   any non-driver account
 *
 * Three tiers, each skipped with a clear SKIP line rather than failed when what
 * it needs is absent:
 *
 *   1. Auth contract — no cookie is 401 on all four routes. Needs only the server.
 *   2. Role and validation — a customer is 403 not_rider; a rider's malformed
 *      bodies are 400. Needs the QA accounts, not migration 0081 (validation
 *      runs before any table is touched).
 *   3. The availability flow — online, stale until a fix, break, resume, sign-out.
 *      Needs migration 0081. Detected from /api/rider/me (`riderCode` is null
 *      until 0081 issues one). On a database without it, the same routes are
 *      asserted to fail CLOSED instead: 503 migration_pending.
 *
 * It signs the rider out first and last, so it leaves them offline. It never
 * runs against production: point BASE at a dev or staging server.
 */
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const RIDER_EMAIL = process.env.QA_RIDER_EMAIL ?? "";
const RIDER_PASSWORD = process.env.QA_RIDER_PASSWORD ?? "";
const CUSTOMER_EMAIL = process.env.QA_CUSTOMER_EMAIL ?? "";
const CUSTOMER_PASSWORD = process.env.QA_CUSTOMER_PASSWORD ?? "";

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

function skip(why: string): void {
  console.log(`SKIP ${why}`);
}

interface Res {
  status: number;
  // Loosely typed on purpose: this script asserts shapes, it does not trust them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any> | null;
}

async function call(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {}
): Promise<Res> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  let json: Res["json"] = null;
  try {
    json = (await res.json()) as Res["json"];
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** A Cookie header the Next.js SSR client accepts (same approach as idor-suite). */
async function sessionCookie(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const ROUTES: { path: string; method: string; body?: unknown }[] = [
  { path: "/api/rider/me", method: "GET" },
  { path: "/api/rider/status", method: "POST", body: { action: "online" } },
  { path: "/api/rider/location", method: "POST", body: { lat: 21.7157, lng: 81.5335 } },
  { path: "/api/rider/signout", method: "POST", body: {} },
];

// A fix inside the service area, for the flow.
const FIX = { lat: 21.7157, lng: 81.5335 };

async function main(): Promise<void> {
  try {
    await call("/api/rider/me");
  } catch {
    skip(`dev server unreachable at ${BASE} — start it with \`npm run dev\``);
    return;
  }

  // ---- 1. no session -------------------------------------------------------
  for (const r of ROUTES) {
    const res = await call(r.path, { method: r.method, body: r.body });
    check(`no cookie -> 401  ${r.method} ${r.path}`, res.status === 401, res);
  }

  // ---- 2a. a customer ------------------------------------------------------
  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const r of ROUTES) {
      const res = await call(r.path, { method: r.method, body: r.body, cookie });
      check(
        `customer -> 403 not_rider  ${r.method} ${r.path}`,
        res.status === 403 && res.json?.error === "not_rider",
        res
      );
    }
  } else {
    skip("customer checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  // ---- 2b. a rider ---------------------------------------------------------
  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks: QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const me = () => call("/api/rider/me", { cookie });
  const status = (body: unknown) => call("/api/rider/status", { method: "POST", cookie, body });
  const location = (body: unknown) => call("/api/rider/location", { method: "POST", cookie, body });
  const signout = () => call("/api/rider/signout", { method: "POST", cookie, body: {} });

  const first = await me();
  check("rider: me -> 200", first.status === 200, first);
  const j = first.json ?? {};
  check("me: shape", typeof j.id === "string" && typeof j.name === "string" && "phone" in j && "avatarUrl" in j, j);
  check("me: availability has the four fields",
    ["isOnline", "breakUntil", "onlineSince", "lastFixAt"].every((k) => k in (j.availability ?? {})), j.availability);
  check("me: phase is one of offline|online|break|stale",
    ["offline", "online", "break", "stale"].includes(j.phase), j.phase);
  check("me: activeDeliveryId is string|null",
    j.activeDeliveryId === null || typeof j.activeDeliveryId === "string", j.activeDeliveryId);
  check("me: five feature switches, all booleans",
    ["driver.history", "driver.earnings", "driver.call_customer", "driver.navigation", "driver.profile_edit"]
      .every((k) => typeof j.features?.[k] === "boolean"), j.features);
  check("me: legal links are string|null",
    ["privacyUrl", "termsUrl"].every((k) => j.legal?.[k] === null || typeof j.legal?.[k] === "string"), j.legal);

  // Validation runs before any table is touched, so it holds with or without 0081.
  const dance = await status({ action: "dance" });
  check("status {action:\"dance\"} -> 400 invalid_action", dance.status === 400 && dance.json?.error === "invalid_action", dance);
  const noAction = await status({});
  check("status {} -> 400 invalid_action", noAction.status === 400 && noAction.json?.error === "invalid_action", noAction);
  const badMinutes = await status({ action: "break", minutes: "soon" });
  check("status break minutes:\"soon\" -> 400 invalid_minutes",
    badMinutes.status === 400 && badMinutes.json?.error === "invalid_minutes", badMinutes);
  const noMinutes = await status({ action: "break" });
  check("status break without minutes -> 400 invalid_minutes",
    noMinutes.status === 400 && noMinutes.json?.error === "invalid_minutes", noMinutes);
  for (const [name, body] of [
    ["strings", { lat: "21.7", lng: "81.5" }],
    ["missing", {}],
    ["(0, 0)", { lat: 0, lng: 0 }],
    ["lat out of range", { lat: 91, lng: 81.5 }],
    ["swapped", { lat: 81.5, lng: 21.7 }],
  ] as const) {
    const r = await location(body);
    check(`location ${name} -> 400 invalid_position`, r.status === 400 && r.json?.error === "invalid_position", r);
  }

  // ---- 3. the flow — or, without 0081, failing closed ----------------------
  const schemaPresent = j.riderCode !== null && j.riderCode !== undefined;
  if (!schemaPresent) {
    check("no 0081: me still answers offline with riderCode null",
      first.status === 200 && j.riderCode === null && j.phase === "offline" && j.availability?.isOnline === false, j);
    skip("availability flow: /api/rider/me shows riderCode null — migration 0081 is not applied here");
    const on = await status({ action: "online" });
    check("no 0081: status online -> 503 migration_pending", on.status === 503 && on.json?.error === "migration_pending", on);
    const fix = await location(FIX);
    check("no 0081: location -> 503 migration_pending", fix.status === 503 && fix.json?.error === "migration_pending", fix);
    const out = await signout();
    check("no 0081: signout -> 503 migration_pending", out.status === 503 && out.json?.error === "migration_pending", out);
    return;
  }

  check("me: riderCode matches DR-nnnn", /^DR-\d{4,}$/.test(String(j.riderCode)), j.riderCode);

  // Clean slate.
  const clean = await signout();
  check("signout -> 200 { ok: true }", clean.status === 200 && clean.json?.ok === true, clean);
  const off = (await me()).json ?? {};
  check("after signout: offline", off.availability?.isOnline === false && off.phase === "offline", off);
  const hasDelivery = off.activeDeliveryId !== null;
  if (hasDelivery) skip("this rider has a delivery in flight: expect active_delivery on offline/break below");

  // A fix while offline is acknowledged and NOT kept.
  const before = off.availability?.lastFixAt ?? null;
  const dropped = await location(FIX);
  check("location while offline -> online:false", dropped.status === 200 && dropped.json?.ok === true && dropped.json?.online === false, dropped);
  const afterDrop = (await me()).json ?? {};
  check("location while offline: lastFixAt unchanged", (afterDrop.availability?.lastFixAt ?? null) === before, afterDrop.availability);

  // break / resume while offline
  const offBreak = await status({ action: "break", minutes: 15 });
  check("break while offline -> 409 not_online", offBreak.status === 409 && offBreak.json?.error === "not_online", offBreak);
  const offResume = await status({ action: "resume" });
  check("resume while offline -> 409 not_online", offResume.status === 409 && offResume.json?.error === "not_online", offResume);

  // online -> stale until a fix
  const on = await status({ action: "online" });
  check("online -> 200 phase stale (no fix yet)", on.status === 200 && on.json?.phase === "stale" && on.json?.availability?.isOnline === true, on);
  const fix = await location(FIX);
  check("location while online -> online:true", fix.status === 200 && fix.json?.online === true, fix);
  const live = (await me()).json ?? {};
  check("after a fix: phase online, lastFixAt set", live.phase === "online" && typeof live.availability?.lastFixAt === "string", live);

  // breaks
  if (hasDelivery) {
    const refused = await status({ action: "break", minutes: 15 });
    check("break with a delivery -> 409 active_delivery", refused.status === 409 && refused.json?.error === "active_delivery", refused);
  } else {
    const bad = await status({ action: "break", minutes: 45 });
    check("break 45 -> 400 invalid_minutes", bad.status === 400 && bad.json?.error === "invalid_minutes", bad);
    const brk = await status({ action: "break", minutes: 15 });
    check("break 15 -> phase break", brk.status === 200 && brk.json?.phase === "break", brk);
    const res = await status({ action: "resume" });
    check("resume -> phase online", res.status === 200 && res.json?.phase === "online", res);
    const open = await status({ action: "break", minutes: null });
    check("break null -> until resumed (year 9999)",
      open.status === 200 && open.json?.phase === "break" &&
        new Date(open.json?.availability?.breakUntil).getUTCFullYear() === 9999, open);
    const res2 = await status({ action: "resume" });
    check("resume after open-ended break -> online", res2.status === 200 && res2.json?.phase === "online", res2);
  }

  // sign-out takes the rider offline
  const done = await signout();
  check("signout -> 200", done.status === 200 && done.json?.ok === true, done);
  const last = (await me()).json ?? {};
  check("after signout: me.availability.isOnline === false", last.availability?.isOnline === false, last.availability);
  check("after signout: no position kept", last.availability?.lastFixAt === null, last.availability);
}

main()
  .catch((e) => {
    failed++;
    console.log(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    console.log(failed ? `FAILED ${failed} (passed ${passed})` : `PASS ${passed} checks`);
    process.exit(failed ? 1 : 0);
  });
