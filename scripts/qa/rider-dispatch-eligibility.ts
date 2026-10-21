/**
 * Who dispatch may offer a pickup to (src/lib/dispatch/eligibility.ts) — pure,
 * no database.
 *
 *   npx tsx scripts/qa/rider-dispatch-eligibility.ts
 *
 * The same rule decides it for every caller: online, not on a break, and a
 * position newer than RIDER_PRESENCE_MS. A rider with no rider_status row has
 * never gone online and is not eligible.
 */
import assert from "node:assert/strict";
import { eligibleCandidates } from "../../src/lib/dispatch/eligibility";
import { BREAK_UNTIL_RESUMED, type RiderAvailability } from "../../src/lib/rider/availability";

const now = new Date("2026-10-21T10:00:00.000Z");
const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

const live = (over: Partial<RiderAvailability> = {}): RiderAvailability => ({
  isOnline: true,
  breakUntil: null,
  onlineSince: at(3_600_000),
  lastFixAt: at(10_000),
  ...over,
});

function ok(name: string, fn: () => void): void {
  fn();
  console.log(`ok   ${name}`);
}

const ids = (riders: { id: string }[]) => riders.map((r) => r.id);
const riders = (...rs: string[]) => rs.map((id) => ({ id, name: `Rider ${id}` }));

ok("an offline rider is excluded", () => {
  const map = new Map([["a", live({ isOnline: false, onlineSince: null, lastFixAt: null })]]);
  assert.deepEqual(eligibleCandidates(riders("a"), map, now), []);
});

ok("a rider with no rider_status row is excluded", () => {
  assert.deepEqual(eligibleCandidates(riders("a"), new Map(), now), []);
});

ok("an online rider with a fresh fix is included", () => {
  const map = new Map([["a", live()]]);
  assert.deepEqual(ids(eligibleCandidates(riders("a"), map, now)), ["a"]);
});

ok("an online rider on a timed break is excluded; once the break ends, included", () => {
  const onBreak = new Map([["a", live({ breakUntil: ahead(10 * 60_000) })]]);
  assert.deepEqual(eligibleCandidates(riders("a"), onBreak, now), []);
  const over = new Map([["a", live({ breakUntil: at(60_000) })]]);
  assert.deepEqual(ids(eligibleCandidates(riders("a"), over, now)), ["a"]);
});

ok("an 'until I resume' break (9999) is excluded", () => {
  const map = new Map([["a", live({ breakUntil: BREAK_UNTIL_RESUMED })]]);
  assert.deepEqual(eligibleCandidates(riders("a"), map, now), []);
});

ok("an online rider whose fix is 6 minutes old is excluded; 4 minutes old is included", () => {
  const stale = new Map([["a", live({ lastFixAt: at(6 * 60_000) })]]);
  assert.deepEqual(eligibleCandidates(riders("a"), stale, now), []);
  const recent = new Map([["a", live({ lastFixAt: at(4 * 60_000) })]]);
  assert.deepEqual(ids(eligibleCandidates(riders("a"), recent, now)), ["a"]);
});

ok("an online rider who has never sent a fix is excluded", () => {
  const map = new Map([["a", live({ lastFixAt: null })]]);
  assert.deepEqual(eligibleCandidates(riders("a"), map, now), []);
});

ok("input order is preserved, and the objects are returned as given", () => {
  const input = riders("d", "a", "c", "b", "e");
  const map = new Map<string, RiderAvailability>([
    ["a", live()],
    ["b", live()],
    ["c", live({ isOnline: false })],
    ["d", live()],
    // "e" has no row
  ]);
  const out = eligibleCandidates(input, map, now);
  assert.deepEqual(ids(out), ["d", "a", "b"]);
  assert.equal(out[0], input[0]);
  assert.equal(input.length, 5, "the input is not mutated");
});

console.log("PASS rider dispatch eligibility");
