/**
 * QA — what the web vendor menu tells a shop about Deligro's moderation of a
 * dish (0146): parked price, waiting for approval, not approved, hidden by
 * Deligro, and "status unavailable" when the state could not be read.
 *
 * Usage: npx tsx scripts/qa/vendor-menu-moderation.ts
 */
import { readFileSync } from "node:fs";
import { moderationNotice } from "../../src/lib/menu/moderation-notice";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const base = { price: 200, approvalStatus: "approved" as const, pendingPrice: null, hidden: false, hiddenReason: null, approvalNote: null };

check("an approved dish shows nothing", moderationNotice(base) === null);
let n = moderationNotice({ ...base, approvalStatus: "pending", pendingPrice: 250 });
check("a parked price: still on sale at the old price, the new one waiting",
  n?.label === "New price waiting for approval" && n.detail.includes("₹200") && n.detail.includes("₹250") && n.tone === "pending", n);
n = moderationNotice({ ...base, approvalStatus: "pending", approvalNote: "Size added: Bottle" });
check("pending without a parked price: off sale, with Deligro's note",
  n?.label === "Waiting for approval" && n.detail.includes("not on sale") && n.detail.includes("Size added: Bottle"), n);
n = moderationNotice({ ...base, approvalStatus: "rejected", approvalNote: "No licence" });
check("rejected: says so with the reason, and how to resubmit", n?.label === "Not approved" && n.detail.includes("No licence") && n.tone === "critical", n);
n = moderationNotice({ ...base, hidden: true, hiddenReason: "Wrong photo" });
check("hidden by Deligro wins over everything, with the reason", n?.label === "Hidden by Deligro" && n.detail.includes("Wrong photo"), n);
n = moderationNotice({ ...base, approvalStatus: "unknown" });
check("an unreadable state says so — never 'approved'", n?.label === "Status unavailable", n);

const menu = readFileSync("src/lib/data-access/vendor-menu.ts", "utf8");
check("loadModeration: a read error other than a missing column marks dishes unknown",
  /unknown/.test(menu) && menu.includes("isMissingColumn(error)"));
const card = readFileSync("src/components/vendor/menu-item-card.tsx", "utf8");
check("the web vendor menu card renders the notice", card.includes("moderationNotice("));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
