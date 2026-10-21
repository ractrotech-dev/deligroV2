/**
 * Rider availability rules (src/lib/rider/availability.ts) — pure, no database.
 *
 *   npx tsx scripts/qa/rider-availability.ts
 */
import assert from "node:assert/strict";
import {
  BREAK_MINUTES,
  RIDER_PRESENCE_MS,
  isDispatchable,
  nextAvailability,
  riderPhase,
  type RiderAvailability,
} from "../../src/lib/rider/availability";
import { breakLabel } from "../../src/lib/rider/break-label";

const now = new Date("2026-10-21T10:00:00.000Z");
const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

const offline: RiderAvailability = {
  isOnline: false,
  breakUntil: null,
  onlineSince: null,
  lastFixAt: null,
};
const online: RiderAvailability = {
  isOnline: true,
  breakUntil: null,
  onlineSince: at(3_600_000),
  lastFixAt: at(10_000),
};
const free = { hasCommitment: false, now };
const busy = { hasCommitment: true, now };

function ok(name: string, fn: () => void): void {
  fn();
  console.log(`ok   ${name}`);
}

ok("constants", () => {
  assert.equal(RIDER_PRESENCE_MS, 300_000);
  assert.deepEqual([...BREAK_MINUTES], [15, 30, 60]);
});

ok("online from offline opens a shift, stamps onlineSince, clears the break", () => {
  const stale = { ...offline, breakUntil: ahead(60_000) };
  const r = nextAvailability(stale, "online", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "open");
  assert.equal(r.next.isOnline, true);
  assert.equal(r.next.onlineSince, now.toISOString());
  assert.equal(r.next.breakUntil, null);
});

ok("online when already online is a no-op", () => {
  const r = nextAvailability(online, "online", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "none");
  assert.deepEqual(r.next, online);
});

ok("online ends a break without opening a second shift", () => {
  const onBreak = { ...online, breakUntil: ahead(600_000) };
  const r = nextAvailability(onBreak, "online", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "none");
  assert.equal(r.next.breakUntil, null);
  assert.equal(r.next.onlineSince, online.onlineSince);
});

ok("offline closes the shift and clears the break and the position stamp", () => {
  const r = nextAvailability({ ...online, breakUntil: ahead(1000) }, "offline", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "close");
  assert.equal(r.next.isOnline, false);
  assert.equal(r.next.breakUntil, null);
  assert.equal(r.next.onlineSince, null);
  assert.equal(r.next.lastFixAt, null);
});

ok("offline while already offline is a no-op", () => {
  const r = nextAvailability(offline, "offline", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "none");
});

ok("offline with a commitment is refused: active_delivery", () => {
  assert.deepEqual(nextAvailability(online, "offline", busy), {
    ok: false,
    error: "active_delivery",
  });
});

ok("break with a commitment is refused: active_delivery", () => {
  assert.deepEqual(nextAvailability(online, "break", { ...busy, minutes: 15 }), {
    ok: false,
    error: "active_delivery",
  });
});

ok("break 45 is invalid_minutes", () => {
  assert.deepEqual(nextAvailability(online, "break", { ...free, minutes: 45 }), {
    ok: false,
    error: "invalid_minutes",
  });
});

ok("break with minutes omitted is invalid_minutes (null is the only open-ended form)", () => {
  assert.deepEqual(nextAvailability(online, "break", free), {
    ok: false,
    error: "invalid_minutes",
  });
});

ok("break 15 / 30 / 60 end that many minutes from now", () => {
  for (const m of BREAK_MINUTES) {
    const r = nextAvailability(online, "break", { ...free, minutes: m });
    assert.ok(r.ok);
    assert.equal(r.shift, "none");
    assert.equal(r.next.breakUntil, new Date(now.getTime() + m * 60_000).toISOString());
    assert.equal(r.next.isOnline, true);
  }
});

ok("break null lasts until resumed: breakUntil in year 9999", () => {
  const r = nextAvailability(online, "break", { ...free, minutes: null });
  assert.ok(r.ok);
  assert.equal(new Date(r.next.breakUntil as string).getUTCFullYear(), 9999);
  assert.equal(r.next.breakUntil, "9999-12-31T00:00:00.000Z");
});

ok("break while offline is not_online", () => {
  assert.deepEqual(nextAvailability(offline, "break", { ...free, minutes: 15 }), {
    ok: false,
    error: "not_online",
  });
});

ok("resume while offline is not_online", () => {
  assert.deepEqual(nextAvailability(offline, "resume", free), {
    ok: false,
    error: "not_online",
  });
});

ok("resume clears the break and keeps the shift", () => {
  const r = nextAvailability({ ...online, breakUntil: ahead(900_000) }, "resume", free);
  assert.ok(r.ok);
  assert.equal(r.shift, "none");
  assert.equal(r.next.breakUntil, null);
  assert.equal(r.next.isOnline, true);
});

ok("resume with nothing to resume is a no-op, not an error", () => {
  const r = nextAvailability(online, "resume", free);
  assert.ok(r.ok);
  assert.deepEqual(r.next, online);
});

ok("nextAvailability does not mutate its input", () => {
  const frozen = Object.freeze({ ...online });
  nextAvailability(frozen, "break", { ...free, minutes: 30 });
  nextAvailability(frozen, "offline", free);
});

ok("isDispatchable: false at fix age 5 min 1 s, true at 4 min 59 s", () => {
  assert.equal(isDispatchable({ ...online, lastFixAt: at(5 * 60_000 + 1000) }, now), false);
  assert.equal(isDispatchable({ ...online, lastFixAt: at(4 * 60_000 + 59_000) }, now), true);
});

ok("isDispatchable: exactly at the presence limit is stale (strictly inside only)", () => {
  assert.equal(isDispatchable({ ...online, lastFixAt: at(RIDER_PRESENCE_MS) }, now), false);
});

ok("isDispatchable: offline or never fixed is false", () => {
  assert.equal(isDispatchable(offline, now), false);
  assert.equal(isDispatchable({ ...online, lastFixAt: null }, now), false);
  assert.equal(isDispatchable({ ...online, lastFixAt: "garbage" }, now), false);
});

ok("isDispatchable: false while breakUntil is in the future, true once it has passed", () => {
  assert.equal(isDispatchable({ ...online, breakUntil: ahead(1000) }, now), false);
  assert.equal(isDispatchable({ ...online, breakUntil: at(1000) }, now), true);
  assert.equal(isDispatchable({ ...online, breakUntil: now.toISOString() }, now), true);
});

ok("isDispatchable: a fix dated in the future still counts as fresh only within the window", () => {
  // Clock skew between phone and server must not make a rider immortal.
  assert.equal(isDispatchable({ ...online, lastFixAt: ahead(RIDER_PRESENCE_MS * 2) }, now), false);
  assert.equal(isDispatchable({ ...online, lastFixAt: ahead(5_000) }, now), true);
});

ok("riderPhase", () => {
  assert.equal(riderPhase(offline, now), "offline");
  assert.equal(riderPhase(online, now), "online");
  assert.equal(riderPhase({ ...online, lastFixAt: at(6 * 60_000) }, now), "stale");
  assert.equal(riderPhase({ ...online, lastFixAt: null }, now), "stale");
  assert.equal(riderPhase({ ...online, breakUntil: ahead(60_000) }, now), "break");
  // A break outranks a stale fix: the rider chose to pause.
  assert.equal(
    riderPhase({ ...online, breakUntil: ahead(60_000), lastFixAt: at(6 * 60_000) }, now),
    "break"
  );
  // A break that has run out is not a break.
  assert.equal(riderPhase({ ...online, breakUntil: at(1000) }, now), "online");
});

ok("breakLabel: 'until I resume' is words, never a date; a timed break is an IST clock time", () => {
  // The far-future stamp the server stores for "until I resume" (ruling R4).
  assert.equal(breakLabel("9999-12-31T00:00:00.000Z"), "Until you resume");
  assert.equal(breakLabel("9999-12-31T00:00:00Z"), "Until you resume");
  // 10:00 UTC is 15:30 IST.
  assert.equal(breakLabel("2026-10-21T10:00:00.000Z"), "Until 3:30 pm");
  assert.equal(breakLabel("2026-10-21T18:30:00.000Z"), "Until 12:00 am");
  assert.equal(breakLabel("2026-10-21T06:35:00.000Z"), "Until 12:05 pm");
  assert.equal(breakLabel("2026-10-21T03:45:00.000Z"), "Until 9:15 am");
  assert.equal(breakLabel(null), null);
  assert.equal(breakLabel("not a date"), null);
});

console.log("PASS rider availability");
