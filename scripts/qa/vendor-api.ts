/**
 * QA — the vendor API base the Partner app stands on.
 *
 * `/api/vendor/me` is the first call the app makes after sign-in: who is this,
 * which shops do they run, which shop is active, which features are on.
 * `/api/auth/password-login` is the mobile + password door for native apps.
 * Both are reached from outside the website, so their refusals matter as much
 * as their answers.
 *
 * Needs a running server (`npm run dev`); skips with a notice when it cannot
 * reach one. The signed-in half runs only when a test vendor is configured:
 *   QA_VENDOR_MOBILE=98xxxxxxxx QA_PASSWORD='…' BASE_URL=http://localhost:3005 npx tsx scripts/qa/vendor-api.ts
 */
import { BASE_URL, SUPABASE_URL } from "./_env";

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

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The `@supabase/ssr` session cookie, as the Flutter apps build it. */
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

async function main(): Promise<void> {
  try {
    await fetch(BASE_URL);
  } catch {
    console.log(`  – skipped: no server at ${BASE_URL} (start one with npm run dev)`);
    return;
  }

  console.log("\n═══ /api/vendor/me refuses without a session ═══");
  const anon = await call("/api/vendor/me");
  check("no session → 401", anon.status, 401);
  check("...with error unauthenticated", anon.body.error, "unauthenticated");

  console.log("\n═══ the order routes refuse without a session ═══");
  check("board → 401", (await call("/api/vendor/orders/board")).status, 401);
  check("order detail → 401", (await call("/api/vendor/orders/00000000-0000-0000-0000-000000000000")).status, 401);
  check(
    "start preparing → 401",
    (await call("/api/vendor/orders/00000000-0000-0000-0000-000000000000/preparing", { method: "POST" })).status,
    401
  );
  check("dashboard → 401", (await call("/api/vendor/dashboard")).status, 401);
  check("analytics → 401", (await call("/api/vendor/analytics?granularity=day")).status, 401);

  console.log("\n═══ /api/auth/password-login refuses bad input ═══");
  const empty = await call("/api/auth/password-login", json({}));
  check("empty body → 400", empty.status, 400);
  check("...bad_request", empty.body.error, "bad_request");
  const garbage = await call("/api/auth/password-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("malformed JSON → 400", garbage.status, 400);

  // A number nobody has: the same answer a wrong password gets.
  const stranger = `9${String(Date.now()).slice(-9)}`;
  const unknown = await call("/api/auth/password-login", json({ mobile: stranger, password: "not-it-123" }));
  check("unknown number → 401", unknown.status, 401);
  check("...bad_credentials, same as a wrong password", unknown.body.error, "bad_credentials");

  console.log("\n═══ password guessing is capped per number ═══");
  const target = `8${String(Date.now()).slice(-9)}`;
  let limited = false;
  for (let i = 0; i < 11; i++) {
    const r = await call("/api/auth/password-login", json({ mobile: target, password: `guess-${i}` }));
    if (r.status === 429) limited = true;
  }
  check("the 11th attempt on one number in 15 min is refused", limited, true);

  const mobile = process.env.QA_VENDOR_MOBILE ?? "";
  const password = process.env.QA_PASSWORD ?? "";
  if (!mobile || !password) {
    console.log("\n  – signed-in checks skipped: set QA_VENDOR_MOBILE and QA_PASSWORD");
    return;
  }

  console.log("\n═══ a vendor signs in and reads /me ═══");
  const login = await call("/api/auth/password-login", json({ mobile, password }));
  check("vendor login → 200", login.status, 200);
  const access = String(login.body.accessToken ?? "");
  const refresh = String(login.body.refreshToken ?? "");
  check("...returns an access token", access.length > 20, true);
  check("...and a refresh token", refresh.length > 5, true);

  const cookie = sessionCookie({
    access_token: access,
    refresh_token: refresh,
    expires_at: login.body.expiresAt,
    token_type: "bearer",
  });
  const me = await call("/api/vendor/me", { headers: { cookie } });
  check("/me with the session → 200", me.status, 200);
  const shops = (me.body.shops ?? []) as { slug: string }[];
  check("...lists at least one shop", shops.length >= 1, true);
  check(
    "...and the active shop is one of them",
    shops.some((s) => s.slug === me.body.activeSlug),
    true
  );
  const features = (me.body.features ?? {}) as Record<string, boolean>;
  check("...with vendor feature switches", typeof features["vendor.menu_edit"], "boolean");
  check("...and no manager or rider switches", "manager.cash" in features, false);

  const stale = await call("/api/vendor/me", {
    headers: { cookie: `${cookie}; vendor_restaurant_slug=not-a-shop-of-mine` },
  });
  check(
    "a shop cookie for someone else's shop falls back to an owned shop",
    shops.some((s) => s.slug === stale.body.activeSlug),
    true
  );
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
