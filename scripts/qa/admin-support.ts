/**
 * QA — rider app Phase 7 Task 3: the admin support desk, emergencies and
 * announcements, and the manager's emergency view.
 *
 *   npm run test:admin-support   # tsx --conditions=react-server
 *
 *   BASE (optional)   a running dev server: signed out, every new page is sent
 *                     to its sign-in (GET only, nothing written). SKIPped
 *                     without it.
 *
 * Tiers:
 *
 *   1. Pure — the form parsers every action runs first
 *      (`lib/support/admin-forms.ts`: a reply or internal note with an
 *      optional status, an announcement with IST start/end), and
 *      `managerMaySeeTicket`, the same rule as 0087's `is_rider_ops_ticket`.
 *   2. Structure — non-admins are refused: every exported function of the
 *      action files is a server action whose FIRST statement is the role gate
 *      (`requireRole("admin")` on the desk and the composer,
 *      `requireRole(["manager", "admin"])` on the emergency feed), every write
 *      is rate-limited straight after, every page checks its own role (the
 *      layout is not a guard), and the manager's ticket page refuses tickets
 *      managers may not read. The nav lists Support and Announcements for
 *      both shells.
 *   3. Route contract (optional, BASE).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = (process.env.BASE ?? "").replace(/\/$/, "");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}
async function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}
const src = (p: string) => readFileSync(join(root, p), "utf8");
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function pureTier(): Promise<void> {
  const forms = await import("../../src/lib/support/admin-forms");
  const rules = await import("../../src/lib/support/rules");

  await group("reply form: a public reply, an internal note, a status", () => {
    assert.deepEqual(forms.replyFromForm(form({ body: "  On it  " })), { ok: true, value: { body: "On it", internal: false, status: null } });
    assert.deepEqual(forms.replyFromForm(form({ body: "check logs", internal: "on", status: "in_progress" })), {
      ok: true,
      value: { body: "check logs", internal: true, status: "in_progress" },
    });
    assert.deepEqual(forms.replyFromForm(form({ body: "   " })), { ok: false, error: "invalid_body" });
    assert.deepEqual(forms.replyFromForm(form({ body: "x", status: "deleted" })), { ok: false, error: "invalid_status" });
    assert.equal(forms.replyFromForm(form({ body: "x".repeat(4001) })).ok, false);
    assert.match(forms.deskError("invalid_body"), /write/i, "errors read as sentences");
  });

  await group("announcement form: IST start/end become instants; bad input is a sentence", () => {
    const ok = forms.announcementFromForm(form({ audience: "rider", title: "Rain bonus", body: "₹20 extra a delivery today", startsAt: "2030-01-05T09:30", endsAt: "2030-01-05T21:00", push: "on" }));
    assert.ok(ok.ok);
    if (!ok.ok) return;
    assert.equal(ok.value.startsAt, "2030-01-05T04:00:00.000Z", "09:30 IST is 04:00 UTC");
    assert.equal(ok.value.endsAt, "2030-01-05T15:30:00.000Z");
    assert.equal(ok.value.push, true);
    const now = forms.announcementFromForm(form({ audience: "all", title: "Holiday hours", body: "Closed at 9" }));
    assert.ok(now.ok && now.value.startsAt === null && now.value.push === false, "blank start = now; push only when ticked");
    assert.deepEqual(forms.announcementFromForm(form({ audience: "customer", title: "Hello", body: "x" })), { ok: false, error: "invalid_audience" });
    assert.deepEqual(forms.announcementFromForm(form({ audience: "rider", title: "Hello", body: "x", startsAt: "2030-01-05T09:30", endsAt: "2030-01-05T09:00" })), { ok: false, error: "invalid_dates" });
    assert.deepEqual(forms.announcementFromForm(form({ audience: "rider", title: "Hello", body: "x", startsAt: "tomorrow" })), { ok: false, error: "invalid_dates" });
    assert.match(forms.announcementError("invalid_title"), /3/);
  });

  await group("managerMaySeeTicket mirrors 0087's is_rider_ops_ticket", () => {
    const t = (requesterRole: string, priority: string, category: string) => rules.managerMaySeeTicket({ requesterRole, priority, category });
    assert.equal(t("rider", "emergency", "other"), true, "any rider emergency");
    for (const c of ["vendor_not_handing_over", "customer_unreachable", "incorrect_address", "delivery_payment", "cash_reconciliation", "accident_emergency", "missing_items", "wrong_package", "vendor_delay", "other_issue", "unsafe_situation", "accident", "vehicle_breakdown", "harassment_threat", "suspicious_order_location"]) {
      assert.equal(t("rider", "normal", c), true, c);
    }
    assert.equal(t("rider", "normal", "app_technical"), false, "a rider's app question is admin-only");
    assert.equal(t("rider", "normal", "other"), false);
    assert.equal(t("vendor", "emergency", "payments"), false, "never a shop's ticket");
    const sql = src("supabase/migrations/0087_support_notifications.sql");
    for (const c of ["vendor_not_handing_over", "accident_emergency", "vendor_delay", "suspicious_order_location"]) {
      assert.ok(sql.includes(`'${c}'`), `0087 lists ${c}`);
    }
  });
}

/** The body of each exported async function, from its signature to the closing brace at column 0. */
function exportedBodies(text: string): { name: string; body: string }[] {
  return [...text.matchAll(/export async function (\w+)\([\s\S]*?\)[^{]*\{([\s\S]*?)\n\}/g)].map((m) => ({ name: m[1], body: m[2] }));
}
function firstStatement(body: string): string {
  return body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))[0] ?? "";
}

async function structureTier(): Promise<void> {
  await group("desk and composer actions: \"use server\", requireRole(\"admin\") first, rate-limited", () => {
    for (const f of ["src/app/admin/support/actions.ts", "src/app/admin/announcements/actions.ts"]) {
      const text = src(f);
      assert.match(text, /^"use server";/, `${f} is a server-action module`);
      const fns = exportedBodies(text);
      assert.ok(fns.length >= 2, `${f}: actions found`);
      for (const fn of fns) {
        assert.match(firstStatement(fn.body), /^const \w+ = await requireRole\("admin"\);$/, `${f} ${fn.name}: first statement is the admin gate`);
        assert.match(fn.body, /rateLimit\(/, `${f} ${fn.name}: rate-limited`);
        assert.ok(fn.body.indexOf("rateLimit(") < fn.body.search(/staffReply\(|setTicketStatus\(|assignTicketToSelf\(|createAnnouncement\(|endAnnouncement\(/), `${f} ${fn.name}: limit before the write`);
      }
    }
  });
  await group("the emergency feed is managers' and admins' only", () => {
    const text = src("src/app/manager/support-actions.ts");
    assert.match(text, /^"use server";/);
    const fns = exportedBodies(text);
    assert.ok(fns.length >= 1);
    for (const fn of fns) {
      assert.match(firstStatement(fn.body), /^const \w+ = await requireRole\(\["manager", "admin"\]\);$/, `${fn.name}: gate first`);
      assert.match(fn.body, /rateLimit\(/, `${fn.name}: rate-limited (it is polled)`);
    }
  });
  await group("every new page checks its own role; the manager ticket page refuses tickets managers may not read", () => {
    for (const [f, gate] of [
      ["src/app/admin/support/page.tsx", 'requireRole("admin")'],
      ["src/app/admin/support/[id]/page.tsx", 'requireRole("admin")'],
      ["src/app/admin/announcements/page.tsx", 'requireRole("admin")'],
      ["src/app/manager/support/[id]/page.tsx", 'requireRole(["manager", "admin"])'],
    ] as const) {
      const text = src(f);
      const body = text.slice(text.indexOf("export default async function"));
      assert.ok(body.includes(`await ${gate}`), `${f}: ${gate}`);
      assert.ok(body.indexOf(gate) < Math.max(body.indexOf("listTicketsForStaff("), body.indexOf("getTicketForStaff("), body.indexOf("listAnnouncements(")), `${f}: gate before the service-role read`);
    }
    const mgr = src("src/app/manager/support/[id]/page.tsx");
    assert.match(mgr, /getTicketForStaff\(id, [^)]*allow: managerMaySeeTicket/, "the manager page applies the 0087 rule on the ticket row, before messages are read or URLs signed");
    assert.match(mgr, /notFound\(\)/);
  });
  await group("nav: Support and Announcements for both shells; home and board carry the emergency banner", () => {
    const nav = src("src/components/admin/admin-nav.ts");
    for (const href of ["/admin/support", "/admin/announcements"]) {
      const at = nav.indexOf(`href: "${href}"`);
      assert.ok(at > 0, `${href} in the nav`);
      const entry = nav.slice(at, nav.indexOf("},", at));
      assert.ok(!entry.includes('reach: "console"'), `${href} works on a phone too`);
    }
    assert.match(src("src/app/admin/page.tsx"), /<EmergencyBanner[\s\S]{0,120}basePath="\/admin\/support"/);
    assert.match(src("src/app/manager/page.tsx"), /<EmergencyBanner[\s\S]{0,120}basePath="\/manager\/support"/);
    assert.match(src("src/app/admin/riders/[id]/page.tsx"), /listTicketsOfRequester\(/, "rider page lists tickets and incidents");
  });
  await group("console rules on the new screens: tokens only, container queries", () => {
    for (const f of [
      "src/app/admin/support/page.tsx",
      "src/app/admin/support/[id]/page.tsx",
      "src/app/admin/support/reply-form.tsx",
      "src/app/admin/announcements/page.tsx",
      "src/app/admin/announcements/announcement-form.tsx",
      "src/components/ops/emergency-banner.tsx",
      "src/app/manager/support/[id]/page.tsx",
    ]) {
      const text = src(f);
      assert.ok(!/\bdark:/.test(text), `${f}: no dark: variant`);
      assert.ok(!/\b(text|bg|border)-(red|blue|green|amber|yellow|gray|slate)-\d{2,3}\b/.test(text), `${f}: no raw palette colour`);
      assert.ok(!/(^|[\s"'`])(sm|md|lg|xl):/.test(text), `${f}: container queries, not viewport breakpoints`);
    }
  });
}

async function contractTier(): Promise<void> {
  if (!BASE) {
    console.log("SKIP route contract: set BASE to a running dev server");
    return;
  }
  try {
    await fetch(`${BASE}/admin/login`, { signal: AbortSignal.timeout(8000) });
  } catch {
    console.log(`SKIP route contract: ${BASE} is not reachable`);
    return;
  }
  for (const path of ["/admin/support", "/admin/support/00000000-0000-4000-8000-000000000000", "/admin/announcements", "/manager/support/00000000-0000-4000-8000-000000000000"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const to = res.headers.get("location") ?? "";
    check(`signed out: GET ${path} -> sent to sign in`, res.status >= 300 && res.status < 400 && /login/.test(to), { status: res.status, to });
  }
}

async function main(): Promise<void> {
  console.log("1. pure");
  await pureTier();
  console.log("2. structure");
  await structureTier();
  console.log("3. route contract");
  await contractTier();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
