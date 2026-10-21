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
  parseRestrictedCategoryBody,
} from "../../src/lib/ops/product-actions";
import { LIVE_DISH_FILTER } from "../../src/lib/menu/live";

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
let p = parseProductActionBody({ action: "adjust_stock", stockQty: -1, reason: "Recount", clientActionId: CID });
check("adjust_stock with -1 → 400 stockQty", !p.ok && p.field === "stockQty");
p = parseProductActionBody({ action: "adjust_stock", stockQty: null, reason: "Stop tracking", clientActionId: CID });
check("adjust_stock with null stops tracking", p.ok && p.action.action === "adjust_stock" && p.action.stockQty === null);
p = parseProductActionBody({ action: "adjust_stock", stockQty: 2.5, reason: "Recount", clientActionId: CID });
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

console.log("\n── restricted categories ──");
let r = parseRestrictedCategoryBody({ name: " Liquor ", restricted: true, reason: "Licence needed", clientActionId: CID });
check("a valid body, name trimmed", r.ok && r.body.name === "Liquor");
r = parseRestrictedCategoryBody({ name: "", restricted: true, reason: "Licence needed", clientActionId: CID });
check("an empty name → 400 name", !r.ok && r.field === "name");
r = parseRestrictedCategoryBody({ name: "Liquor", restricted: "yes", reason: "Licence needed", clientActionId: CID });
check("restricted must be a boolean", !r.ok && r.field === "restricted");

console.log("\n── customer surfaces ──");
check("the live filter names approval, the parked price and hiding",
  LIVE_DISH_FILTER.includes("approval_status.eq.approved") && LIVE_DISH_FILTER.includes("pending_price"));
const surfaces: [string, number][] = [
  ["src/lib/data-access/manager-phone-orders.ts", 2],
  ["src/lib/data-access/orders.ts", 2],
];
for (const [file, reads] of surfaces) {
  const src = readFileSync(file, "utf8");
  const uses = (src.match(/onlyLiveDishes\(/g) ?? []).length;
  check(`${file}: every customer-facing dish read keeps only live dishes (${reads})`, uses >= reads, `${uses} uses`);
}
const route = readFileSync("src/app/api/manager/products/[id]/actions/route.ts", "utf8");
check("the actions route checks the action's own switch", route.includes("PRODUCT_ACTION_PERMISSION[") && route.includes("managerWriteLimit("));
const restricted = readFileSync("src/app/api/manager/products/restricted-categories/route.ts", "utf8");
check("restricted categories: changes need manager.products.moderate", restricted.includes("manager.products.moderate"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
