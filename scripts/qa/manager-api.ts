/**
 * QA — the Manager app's API base.
 *
 * Every `/api/manager/*` route opens with managerApiContext(): no session is
 * 401, the wrong role is 403 `forbidden`, a switched-off power is 403
 * `permission_denied`. These are reached from outside the website, so the
 * refusals matter as much as the answers.
 *
 * Needs a running server (`npm run dev`); skips with a notice when it cannot
 * reach one. The signed-in half runs only with test accounts configured:
 *   QA_MANAGER_MOBILE=98xxxxxxxx QA_PASSWORD='…' [QA_VENDOR_MOBILE=…] BASE_URL=http://localhost:3005 \
 *     npx tsx scripts/qa/manager-api.ts
 */
import { BASE_URL, SUPABASE_URL } from "./_env";
import { FEATURES } from "../../src/lib/features/catalog";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An HTML error page — keep the status.
  }
  return { status: res.status, body };
}

const send = (method: string, body: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function sessionCookie(session: Record<string, unknown>): string {
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const size = 3180;
  if (value.length <= size) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += size, n++) {
    parts.push(`${name}.${n}=${value.slice(i, i + size)}`);
  }
  return parts.join("; ");
}

async function signIn(mobile: string, password: string): Promise<string | null> {
  const login = await call("/api/auth/password-login", send("POST", { mobile, password }));
  if (login.status !== 200) return null;
  return sessionCookie({
    access_token: login.body.accessToken,
    refresh_token: login.body.refreshToken,
    expires_at: login.body.expiresAt,
    token_type: "bearer",
  });
}

async function main(): Promise<void> {
  try {
    await fetch(BASE_URL);
  } catch {
    console.log(`  – skipped: no server at ${BASE_URL} (start one with npm run dev)`);
    return;
  }

  console.log("\n═══ every manager route refuses without a session ═══");
  for (const [method, path, body] of [
    ["GET", "/api/manager/me", null],
    ["GET", "/api/manager/activity", null],
    ["GET", "/api/manager/sessions", null],
    ["DELETE", "/api/manager/sessions", { all: true }],
    ["POST", "/api/manager/password", { current: "a", next: "bbbbbbbb" }],
    ["GET", "/api/manager/notification-prefs", null],
    ["GET", "/api/manager/permissions", null],
    ["PUT", "/api/manager/notification-prefs", { kind: "order_unassigned", push: false }],
  ] as const) {
    const r = await call(path, body ? send(method, body) : { method });
    check(`${method} ${path} → 401`, r.status, 401);
    check(`...unauthenticated`, r.body.error, "unauthenticated");
  }

  const mobile = process.env.QA_MANAGER_MOBILE ?? "";
  const password = process.env.QA_PASSWORD ?? "";
  if (!mobile || !password) {
    console.log("\n  – signed-in checks skipped: set QA_MANAGER_MOBILE and QA_PASSWORD");
    return;
  }

  console.log("\n═══ a manager signs in and reads /me ═══");
  const cookie = await signIn(mobile, password);
  check("manager login → session", cookie !== null, true);
  if (!cookie) return;
  const me = await call("/api/manager/me", { headers: { cookie } });
  check("/me → 200", me.status, 200);
  const perms = (me.body.permissions ?? {}) as Record<string, boolean>;
  const managerKeys = FEATURES.filter((f) => f.role === "manager").map((f) => f.key);
  check("...carries every manager permission", managerKeys.every((k) => typeof perms[k] === "boolean"), true);
  check("...and no vendor switches", "vendor.menu_edit" in perms, false);
  const zones = me.body.zones as { all?: boolean; cities?: unknown[] } | undefined;
  check("...and its zones", Array.isArray(zones?.cities), true);

  console.log("\n═══ refusals for a signed-in manager ═══");
  const bad = await call("/api/manager/password", send("POST", "{not json", cookie));
  check("malformed password body → 400", bad.status, 400);
  const weak = await call("/api/manager/password", send("POST", { current: password, next: "short" }, cookie));
  check("a short new password → 400 weak_password", weak.body.error, "weak_password");
  const wrongKind = await call("/api/manager/notification-prefs", send("PUT", { kind: "not_a_kind", push: false }, cookie));
  check("an unknown alert kind → 400", wrongKind.status, 400);
  const prefs = await call("/api/manager/notification-prefs", { headers: { cookie } });
  check("prefs → 200", prefs.status, 200);
  check("...with every alert kind labelled", Array.isArray(prefs.body.kinds) && (prefs.body.kinds as unknown[]).length === 16, true);
  const permList = await call("/api/manager/permissions", { headers: { cookie } });
  check("permissions → 200", permList.status, 200);
  check("...one row per manager power", (permList.body.permissions as unknown[] | undefined)?.length, managerKeys.length);
  const activity = await call("/api/manager/activity?page=1&pageSize=5", { headers: { cookie } });
  check("activity → 200", activity.status, 200);
  check("...a page of items", Array.isArray(activity.body.items), true);
  const sessions = await call("/api/manager/sessions", { headers: { cookie } });
  check("sessions → 200 (or 501 before 0141)", sessions.status === 200 || sessions.status === 501, true);

  const vendorMobile = process.env.QA_VENDOR_MOBILE ?? "";
  if (vendorMobile) {
    console.log("\n═══ a vendor is not a manager ═══");
    const vendorCookie = await signIn(vendorMobile, password);
    if (vendorCookie) {
      const r = await call("/api/manager/me", { headers: { cookie: vendorCookie } });
      check("vendor /api/manager/me → 403", r.status, 403);
      check("...forbidden", r.body.error, "forbidden");
    }
  }
}

main()
  .catch((err) => {
    failed++;
    console.log(`  ✗ crashed — ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
