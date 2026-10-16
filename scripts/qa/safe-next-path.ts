/**
 * Open-redirect guard: `?next=` must stay on this origin. WHATWG URL parsing
 * drops tabs/newlines and reads a backslash as a slash, so those slip past a
 * plain startsWith("/") check.
 */
import { safeNextPath } from "../../src/lib/auth/portals";
const BS = String.fromCodePoint(92);
const bad: (string | null)[] = [
  "//evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  "/" + BS + "evil.com",
  "/" + BS + BS + "evil.com",
  "https://evil.com",
  "evil.com",
  "",
  null,
];
const good = ["/", "/orders", "/orders/abc?x=1#y", "/restaurant/some-slug", "/admin/vendors/3"];
let fail = 0;
for (const b of bad) {
  const r = safeNextPath(b, "/FALLBACK");
  if (r !== "/FALLBACK") { fail++; console.log("FAIL bad passed:", JSON.stringify(b), "->", r); }
}
for (const g of good) {
  const r = safeNextPath(g, "/FALLBACK");
  if (r !== g) { fail++; console.log("FAIL good rejected:", g, "->", r); }
}
console.log(fail ? "FAILED " + fail : "PASS all " + (bad.length + good.length));
process.exit(fail ? 1 : 0);
