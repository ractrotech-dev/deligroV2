/**
 * QA — the manager's zone scope, the one rule every manager read goes through.
 *
 * An admin sees every zone. A manager sees their assigned zones, and a manager
 * with none sees nothing — never "no filter". Narrowing to one zone must never
 * widen what the scope allows.
 *
 * Pure, no I/O. Usage: npx tsx scripts/qa/manager-scope.ts
 */
import {
  NO_ZONE,
  applyZoneScope,
  narrowScope,
  scopeAllows,
  validateZoneInput,
  type ManagerScope,
} from "../../src/lib/auth/manager-scope";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

const Z1 = "11111111-1111-1111-1111-111111111111";
const Z2 = "22222222-2222-2222-2222-222222222222";
const admin: ManagerScope = { all: true };
const one: ManagerScope = { all: false, zoneIds: [Z1] };
const none: ManagerScope = { all: false, zoneIds: [] };

/** Records the filters a query builder was given. */
function fakeQuery() {
  const calls: { column: string; values: string[] }[] = [];
  const q = {
    calls,
    in(column: string, values: readonly string[]) {
      calls.push({ column, values: [...values] });
      return q;
    },
  };
  return q;
}

console.log("\nManager zone scope\n");

check("admin scope allows any zone", scopeAllows(admin, Z1) && scopeAllows(admin, Z2));
check("admin scope allows a row with no zone", scopeAllows(admin, null));
check("a manager is allowed their zone", scopeAllows(one, Z1));
check("...and not another", !scopeAllows(one, Z2));
check("...and not a row with no zone", !scopeAllows(one, null));
check("a manager with no zones is allowed nothing", !scopeAllows(none, Z1) && !scopeAllows(none, null));

let q = fakeQuery();
applyZoneScope(q, admin);
check("admin scope adds no filter", q.calls.length === 0);

q = fakeQuery();
applyZoneScope(q, one);
check("a manager's query is filtered to their zones", q.calls.length === 1 && q.calls[0].column === "zone_id" && q.calls[0].values.join() === Z1);

q = fakeQuery();
applyZoneScope(q, none);
check("no zones filters to a sentinel that matches nothing", q.calls.length === 1 && q.calls[0].values.join() === NO_ZONE);

q = fakeQuery();
applyZoneScope(q, one, "orders.zone_id");
check("the column can be named (joins)", q.calls[0]?.column === "orders.zone_id");

const n1 = narrowScope(one, Z1);
check("narrowing to an allowed zone keeps it", !n1.all && n1.zoneIds.join() === Z1);
const n2 = narrowScope(one, Z2);
check("narrowing to a zone outside the scope gives nothing", !n2.all && n2.zoneIds.length === 0);
const n3 = narrowScope(admin, Z2);
check("an admin narrowing to a zone gets that zone only", !n3.all && n3.zoneIds.join() === Z2);
check("no narrowing leaves the scope as it was", narrowScope(one, null) === one && narrowScope(admin, undefined) === admin);
check("narrowing to garbage gives nothing", (() => { const s = narrowScope(admin, "not-a-uuid"); return !s.all && s.zoneIds.length === 0; })());

console.log("\nZone input validation\n");
const good = { name: "Bemetara West", centerLat: 21.7, centerLng: 81.5, radiusKm: 4 };
check("a sensible zone is accepted", validateZoneInput(good).ok);
check("latitude out of range is refused", !validateZoneInput({ ...good, centerLat: 91 }).ok);
check("longitude out of range is refused", !validateZoneInput({ ...good, centerLng: -181 }).ok);
check("radius below 0.5 km is refused", !validateZoneInput({ ...good, radiusKm: 0.2 }).ok);
check("radius above 50 km is refused", !validateZoneInput({ ...good, radiusKm: 51 }).ok);
check("a one-letter name is refused", !validateZoneInput({ ...good, name: "B" }).ok);
check("a 61-character name is refused", !validateZoneInput({ ...good, name: "x".repeat(61) }).ok);
check("NaN coordinates are refused", !validateZoneInput({ ...good, centerLat: Number.NaN }).ok);
const r = validateZoneInput({ ...good, name: "  Saja  " });
check("names are trimmed", r.ok && r.value.name === "Saja");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
