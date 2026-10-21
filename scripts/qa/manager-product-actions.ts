/**
 * QA — manager product actions: body validation per action, the permission
 * each needs, restricted-category bodies, and the structural rule that every
 * customer-facing dish read filters out pending and hidden dishes.
 *
 * Usage: npx tsx scripts/qa/manager-product-actions.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  PRODUCT_ACTION_PERMISSION,
  parseProductActionBody,
  parseImageReviewBody,
  parseRestrictedCategoryBody,
  staleStockExtra,
} from "../../src/lib/ops/product-actions";
import { LIVE_DISH_FILTER, isLiveDishRow, readLiveDishes } from "../../src/lib/menu/live";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const CID = randomUUID();

console.log("\n── action bodies ──");
let p = parseProductActionBody({ action: "adjust_stock", stockQty: -1, expectedStockQty: 3, reason: "Recount", clientActionId: CID });
check("adjust_stock with -1 → 400 stockQty", !p.ok && p.field === "stockQty");
p = parseProductActionBody({ action: "adjust_stock", stockQty: null, expectedStockQty: 4, reason: "Stop tracking", clientActionId: CID });
check("adjust_stock with null stops tracking", p.ok && p.action.action === "adjust_stock" && p.action.stockQty === null && p.action.expectedStockQty === 4);
p = parseProductActionBody({ action: "adjust_stock", stockQty: 9, reason: "Recount", clientActionId: CID });
check("adjust_stock without the count the manager saw → 400 expectedStockQty", !p.ok && p.field === "expectedStockQty");
p = parseProductActionBody({ action: "adjust_stock", stockQty: 9, expectedStockQty: null, reason: "Start tracking", clientActionId: CID });
check("expectedStockQty null = the dish was untracked", p.ok && p.action.action === "adjust_stock" && p.action.expectedStockQty === null);
check("a stale answer carries the current count", eq(staleStockExtra("7"), { currentStockQty: 7 }) && eq(staleStockExtra("untracked"), { currentStockQty: null }));
p = parseProductActionBody({ action: "adjust_stock", stockQty: 2.5, expectedStockQty: 1, reason: "Recount", clientActionId: CID });
check("a fractional quantity → 400 stockQty", !p.ok && p.field === "stockQty");
p = parseProductActionBody({ action: "flag", clientActionId: CID });
check("flag without flagReason → 400 flagReason", !p.ok && p.field === "flagReason");
p = parseProductActionBody({ action: "flag", flagReason: "wrong_image", clientActionId: CID });
check("flag needs no reason text", p.ok && p.action.action === "flag");
p = parseProductActionBody({ action: "flag", flagReason: "wrong_image", note: "Photo shows a burger", clientActionId: CID });
check("flag carries its description as note", p.ok && p.action.action === "flag" && p.action.note === "Photo shows a burger");
p = parseProductActionBody({ action: "flag", flagReason: "wrong_image", reason: "Old client text", clientActionId: CID });
check("flag still accepts reason from older clients", p.ok && p.action.action === "flag" && p.action.note === "Old client text");
p = parseProductActionBody({ action: "resolve_flag", reason: "Fixed it", clientActionId: CID });
check("resolve_flag without flagId → 400 flagId", !p.ok && p.field === "flagId");
p = parseProductActionBody({ action: "hide", reason: "no", clientActionId: CID });
check("hide with a 2-character reason → reason_required", !p.ok && p.error === "reason_required");
p = parseProductActionBody({ action: "approve", clientActionId: CID });
check("approve needs no reason", p.ok && p.action.action === "approve");
p = parseProductActionBody({ action: "reject", reason: "", clientActionId: CID });
check("reject needs a reason", !p.ok && p.error === "reason_required");
p = parseProductActionBody({ action: "delete", clientActionId: CID });
check("an unknown action → 400 action", !p.ok && p.field === "action");

console.log("\n── permissions ──");
check("permissions match the plan", eq(PRODUCT_ACTION_PERMISSION, {
  flag: "manager.products.view", hide: "manager.products.moderate", unhide: "manager.products.moderate",
  approve: "manager.products.moderate", reject: "manager.products.moderate", resolve_flag: "manager.products.moderate",
  dismiss_flag: "manager.products.moderate", adjust_stock: "manager.products.adjust_stock",
}));

console.log("\n── image review (§12.7) ──");
let ir = parseImageReviewBody({ outcome: "ok", clientActionId: CID });
check("'Looks fine' needs nothing else", ir.ok && ir.body.outcome === "ok" && ir.body.flagReason === null);
ir = parseImageReviewBody({ outcome: "flag", flagReason: "wrong_image", clientActionId: CID });
check("Flag without a note → reason_required", !ir.ok && ir.error === "reason_required");
ir = parseImageReviewBody({ outcome: "flag", flagReason: "wrong_price", note: "Not this dish", clientActionId: CID });
check("Flag only as wrong_image or inappropriate", !ir.ok && ir.field === "flagReason");
ir = parseImageReviewBody({ outcome: "flag", flagReason: "inappropriate", note: "Shows a person", clientActionId: CID });
check("a valid flag", ir.ok && ir.body.flagReason === "inappropriate" && ir.body.note === "Shows a person");
ir = parseImageReviewBody({ outcome: "maybe", clientActionId: CID });
check("an unknown outcome → 400 outcome", !ir.ok && ir.field === "outcome");
const reviewRoutes = ["src/app/api/manager/products/image-reviews/route.ts", "src/app/api/manager/products/image-reviews/[changeId]/route.ts"];
for (const f of reviewRoutes) {
  let src = "";
  try { src = readFileSync(f, "utf8"); } catch { /* missing */ }
  check(`${f}: exists and needs manager.products.moderate`, src.includes('managerApiContext("manager.products.moderate")'));
}

console.log("\n── restricted categories ──");
let r = parseRestrictedCategoryBody({ name: " Liquor ", restricted: true, reason: "Licence needed", clientActionId: CID });
check("a valid body, name trimmed", r.ok && r.body.name === "Liquor");
r = parseRestrictedCategoryBody({ name: "", restricted: true, reason: "Licence needed", clientActionId: CID });
check("an empty name → 400 name", !r.ok && r.field === "name");
r = parseRestrictedCategoryBody({ name: "Liquor", restricted: "yes", reason: "Licence needed", clientActionId: CID });
check("restricted must be a boolean", !r.ok && r.field === "restricted");

console.log("\n── customer surfaces ──");
check("a live dish row: approved, or parked price; never hidden",
  isLiveDishRow({ approval_status: "approved", pending_price: null, hidden_by_ops: false })
  && isLiveDishRow({ approval_status: "pending", pending_price: 250, hidden_by_ops: false })
  && !isLiveDishRow({ approval_status: "pending", pending_price: null, hidden_by_ops: false })
  && !isLiveDishRow({ approval_status: "rejected", pending_price: null, hidden_by_ops: false })
  && !isLiveDishRow({ approval_status: "approved", pending_price: null, hidden_by_ops: true }));
check("a database without 0146's columns has no moderation: every row is live", isLiveDishRow({}));
async function liveReads() {
  // A fake query builder: filtered reads fail like a pre-0146 database.
  const calls: string[] = [];
  const builder = () => {
    let filtered = false;
    const q = {
      or(f: string) { calls.push(`or:${f}`); filtered = true; return q; },
      eq(c: string) { calls.push(`eq:${c}`); return q; },
      then(res: (v: unknown) => unknown) {
        return Promise.resolve(filtered
          ? { data: null, error: { code: "42703", message: "column menu_items.approval_status does not exist" } }
          : { data: [{ id: "x" }], error: null }).then(res);
      },
    };
    return q;
  };
  const before = await readLiveDishes((live) => live(builder()));
  check("pre-0146: the filtered read fails on a missing moderation column, the unfiltered retry answers",
    !before.error && Array.isArray(before.data) && calls.filter((c) => c.startsWith("or:")).length === 1, JSON.stringify(calls));
  calls.length = 0;
  await readLiveDishes((live) => live(builder()));
  check("...and is remembered: the next read does not filter (no failed round trip)", calls.length === 0, JSON.stringify(calls));
  const other = await readLiveDishes(() => Promise.resolve({ data: null, error: { code: "42703", message: "column menu_items.discount_price does not exist" } }));
  check("another missing column is not mistaken for 0146 — the error stands", !!other.error);
}
const storefront = readFileSync("src/lib/data-access/restaurants.ts", "utf8");
check("the storefront (feed, favourites, shop page, menu-prices, search) drops non-live dishes for staff too",
  storefront.includes("filter(isLiveDishRow)") && storefront.includes("approval_status, pending_price, hidden_by_ops"));
check("the live filter names approval, the parked price and hiding",
  LIVE_DISH_FILTER.includes("approval_status.eq.approved") && LIVE_DISH_FILTER.includes("pending_price"));
const surfaces: [string, number][] = [
  ["src/lib/data-access/manager-phone-orders.ts", 2],
  ["src/lib/data-access/orders.ts", 2],
];
for (const [file, reads] of surfaces) {
  const src = readFileSync(file, "utf8");
  const uses = (src.match(/readLiveDishes\(/g) ?? []).length;
  check(`${file}: every customer-facing dish read keeps only live dishes (${reads})`, uses >= reads, `${uses} uses`);
}
const route = readFileSync("src/app/api/manager/products/[id]/actions/route.ts", "utf8");
check("the actions route checks the action's own switch", route.includes("PRODUCT_ACTION_PERMISSION[") && route.includes("managerWriteLimit("));
const restricted = readFileSync("src/app/api/manager/products/restricted-categories/route.ts", "utf8");
check("restricted categories: changes are admin-only (403 admin_only for a manager)", restricted.includes("admin_only") && restricted.includes('role !== "admin"'));

liveReads().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
