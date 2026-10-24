/**
 * QA — the plain-loop text helpers answer exactly as the regular expressions
 * they replaced did, and stay fast on a long hostile string.
 * Usage: npx tsx scripts/qa/text-shape.ts
 */
import {
  EMAIL_SHAPE,
  containsEmail,
  removeParentheticals,
  stripTrailingParenthetical,
  stripTrailingSlashes,
  trimEdges,
  trimHyphens,
} from "../../src/lib/utils/text-shape";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// A small deterministic generator, so a failure can be reproduced.
let seed = 12345;
const rand = (n: number) => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed % n;
};
const make = (alphabet: string[], max: number) => Array.from({ length: rand(max) }, () => alphabet[rand(alphabet.length)]).join("");

function same(name: string, alphabet: string[], max: number, a: (s: string) => unknown, b: (s: string) => unknown, rounds = 20000) {
  let bad: string | null = null;
  for (let i = 0; i < rounds && bad === null; i++) {
    const s = make(alphabet, max);
    if (a(s) !== b(s)) bad = JSON.stringify(s);
  }
  check(name, bad === null, bad ?? undefined);
}

same("stripTrailingSlashes = /\\/+$/", ["a", "/", "x", ":"], 12, stripTrailingSlashes, (s) => s.replace(/\/+$/, ""));
same("trimHyphens = /^-+|-+$/g", ["a", "-", "b", "_"], 12, trimHyphens, (s) => s.replace(/^-+|-+$/g, ""));
same("trimEdges '_' = /^_+|_+$/g", ["a", "-", "_", "1"], 12, (s) => trimEdges(s, "_"), (s) => s.replace(/^_+|_+$/g, ""));
same("removeParentheticals = /\\(.*?\\)/g", ["a", "(", ")", " ", "b", "/"], 14, removeParentheticals, (s) => s.replace(/\(.*?\)/g, ""));
same("stripTrailingParenthetical = /\\s*\\([^)]*\\)\\s*$/", ["a", "(", ")", " ", "b", "\t"], 14, stripTrailingParenthetical, (s) => s.replace(/\s*\([^)]*\)\s*$/, ""));
same("EMAIL_SHAPE accepts what the old pattern accepted, except empty dot parts", ["a", "b", "@", ".", " ", "1"], 10,
  (s) => EMAIL_SHAPE.test(s),
  (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !/@\.|\.\.|\.$/.test(s));
same("containsEmail = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/", ["a", "b", "@", ".", " ", "1"], 10,
  (s) => containsEmail(s),
  (s) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(s));

check("a plain address passes", EMAIL_SHAPE.test("rider@deligro.in") && EMAIL_SHAPE.test("a.b@c.d.in"));
check("no @, no dot, or a space does not", !EMAIL_SHAPE.test("rider") && !EMAIL_SHAPE.test("a@b") && !EMAIL_SHAPE.test("a b@c.in"));
check("an address inside a sentence is found", containsEmail("write to ops@deligro.in today"));
check("a bare @mention is not an address", !containsEmail("@asha thanks") && !containsEmail("meet @ 5pm"));

// a long hostile string must not take noticeable time
const hostile = "a@" + "a.".repeat(40000);
const t = Date.now();
containsEmail(hostile + " ");
EMAIL_SHAPE.test(hostile);
stripTrailingSlashes("/".repeat(200000) + "x");
stripTrailingParenthetical("(".repeat(20000) + ")");
removeParentheticals("(".repeat(20000));
check("long hostile strings finish quickly", Date.now() - t < 1000, `${Date.now() - t} ms`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
