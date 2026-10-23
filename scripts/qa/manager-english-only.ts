/**
 * QA — the manager side is English only (owner, 2026-10-21) and speaks the client
 * document's words (docs/manager-app-terminology.md). Offline.
 *
 *   npx tsx scripts/qa/manager-english-only.ts                 gates Hindi and tr()
 *   npx tsx scripts/qa/manager-english-only.ts --strict-terms  also gates terminology
 *
 * Rules, each finding printed as  file:line  rule  text :
 *   hindi      any Devanagari character in a manager file
 *   tr         a tr( call, langProvider or labelHi reference under apps/manager, or a
 *              labelHi on a manager.* permission switch
 *   term       a word the terminology table says not to use, inside a user-facing string
 *              (Dart strings with a space or a lone capitalised word; TS strings on label,
 *              title, blurb, body, message, text, summary or heading lines)
 *
 * Vendor and rider (driver) permission switches keep their Hindi labels.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FEATURES } from "../../src/lib/features/catalog";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

const STRICT_TERMS = process.argv.includes("--strict-terms");
const root = join(__dirname, "..", "..");
const DEVANAGARI = /[ऀ-ॿ]/;

/** Paths always use forward slashes, so prefix checks work on Windows too. */
function walk(dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [dir.replace(/\\/g, "/")];
  return readdirSync(full).flatMap((name) => {
    if (name === "node_modules" || name === ".dart_tool" || name === "build" || name === "out" || name === "generated") return [];
    return walk(`${dir.replace(/\\/g, "/")}/${name}`);
  });
}

/** Files whose name starts with `prefix` inside `dir`. */
function withPrefix(dir: string, prefix: string): string[] {
  return walk(dir).filter((f) => f.split(/[\\/]/).pop()!.startsWith(prefix));
}

const tsFiles = [
  ...walk("src/app/api/manager"),
  ...walk("src/app/manager"),
  ...walk("src/app/(portal-auth)/manager"),
  ...walk("src/components/manager"),
  ...walk("src/lib/manager"),
  ...walk("src/lib/ops-alerts"),
  ...walk("src/lib/ops"),
  ...walk("src/lib/reports"),
  ...walk("src/lib/metrics"),
  ...withPrefix("src/lib/data-access", "manager-"),
  ...withPrefix("src/lib/auth", "manager-"),
  ...withPrefix("src/lib/notifications", "ops-"),
  ...withPrefix("src/lib/notifications", "staff"),
  ...walk("src/app/admin/settings/zones"),
  ...walk("src/app/admin/settings/employees"),
  ...walk("src/app/admin/alerts"),
  ...walk("src/app/admin/audit"),
].filter((f, i, a) => a.indexOf(f) === i && /\.(ts|tsx)$/.test(f));

const dartFiles = [...walk("apps/manager/lib"), ...walk("apps/manager/test")].filter((f) => f.endsWith(".dart"));

console.log(`── ${tsFiles.length} manager server files, ${dartFiles.length} app files ──`);

// ── rule: hindi ──
const hindi = [...tsFiles, ...dartFiles].filter((f) => DEVANAGARI.test(readFileSync(join(root, f), "utf8")));
ok("hindi: no Devanagari anywhere on the manager side", hindi.length === 0, hindi);

// ── rule: tr ──
const trHits: string[] = [];
for (const f of dartFiles.filter((f) => f.startsWith("apps/manager/lib"))) {
  readFileSync(join(root, f), "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/\/\//.test(line.trimStart().slice(0, 2))) return;
      if (/(^|[^A-Za-z_])tr\s*\(|langProvider|labelHi/.test(line)) trHits.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
}
ok("tr: no tr(), langProvider or labelHi in apps/manager/lib", trHits.length === 0, trHits.slice(0, 10));

console.log("\n── permission switches ──");
const manager = FEATURES.filter((f) => f.role === "manager");
ok("there are manager switches", manager.length > 0);
ok("no manager switch carries a Hindi label", manager.every((f) => !("labelHi" in f) || !f.labelHi));
const others = FEATURES.filter((f) => f.role !== "manager");
ok("vendor and rider switches keep theirs", others.length > 0 && others.every((f) => typeof f.labelHi === "string" && DEVANAGARI.test(f.labelHi)));

// ── rule: term ──
// Words the client document does not use for these things. "store" stays allowed: §4.6
// and §4.7 say "store information" and "store opening hours".
const AVOID: { re: RegExp; use: string }[] = [
  { re: /\bdrivers?\b/i, use: "Rider" },
  { re: /\bcouriers?\b/i, use: "Rider" },
  { re: /\bshops?\b/i, use: "Vendor" },
  { re: /\brestaurants?\b/i, use: "Vendor" },
  { re: /\border codes?\b/i, use: "Order ID" },
  { re: /\bplatform[- ]funded\b/i, use: "Deligro-funded" },
];

const USER_FACING_TS_LINE = /\b(label|title|blurb|body|message|text|summary|heading|hint|note|description)\s*:/;
const DART_STRING = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
const LONE_WORD = /^(shop|shops|driver|drivers|restaurant|restaurants|courier)$/;

type Finding = { where: string; use: string; text: string };
const terms: Finding[] = [];

function check(where: string, text: string) {
  for (const a of AVOID) if (a.re.test(text)) terms.push({ where, use: a.use, text: text.slice(0, 90) });
}

for (const f of dartFiles.filter((f) => f.startsWith("apps/manager/lib"))) {
  readFileSync(join(root, f), "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trimStart();
      if (t.startsWith("//") || t.startsWith("///") || t.startsWith("import ") || t.startsWith("export ") || t.startsWith("part ")) return;
      for (const m of line.matchAll(DART_STRING)) {
        const s = m[1] ?? m[2] ?? "";
        const human = /[A-Za-z]/.test(s) && (/\s/.test(s.trim()) || LONE_WORD.test(s.toLowerCase()) && /^[A-Z]/.test(s)) && !/[/_=]/.test(s.replace(/\$\{[^}]*\}/g, ""));
        if (human) check(`${f}:${i + 1}`, s);
      }
    });
}
for (const f of tsFiles) {
  readFileSync(join(root, f), "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!USER_FACING_TS_LINE.test(line)) return;
      for (const m of line.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g)) {
        const s = m[1] ?? m[2] ?? m[3] ?? "";
        if (/[A-Za-z]/.test(s) && /\s/.test(s.trim()) && !/[/_=]/.test(s.replace(/\$\{[^}]*\}/g, ""))) check(`${f}:${i + 1}`, s);
      }
    });
}

console.log(`\n── terminology (${AVOID.length} avoided words) ──`);
const byFile = new Map<string, number>();
for (const t of terms) byFile.set(t.where.split(":")[0], (byFile.get(t.where.split(":")[0]) ?? 0) + 1);
for (const t of terms.slice(0, 40)) console.log(`  term  ${t.where}  use "${t.use}"  «${t.text}»`);
if (terms.length > 40) console.log(`  … ${terms.length - 40} more; per file:`);
if (terms.length) for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`        ${String(n).padStart(3)}  ${f}`);
if (STRICT_TERMS) ok("term: no avoided word in a user-facing string", terms.length === 0, `${terms.length} finding(s)`);
else console.log(`  ${terms.length === 0 ? "ok  " : "info"} term: ${terms.length} avoided word(s) in user-facing strings (gated by --strict-terms)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
