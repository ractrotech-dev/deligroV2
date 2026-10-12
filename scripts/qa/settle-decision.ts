/**
 * QA — what a captured payment does to its order.
 *
 * The rule is pure (lib/payments/settle-decision.ts), so it is checked without
 * a database. Runs offline. Usage:  npm run test:settle
 */
import { decideSettlement, totalToPaise } from "../../src/lib/payments/settle-decision";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

console.log("\n── rupees to paise ──");
check("whole rupees", totalToPaise(250) === 25000);
check("paise survive", totalToPaise(249.5) === 24950);
check("float drift does not lose a paisa (0.1 + 0.2)", totalToPaise(0.1 + 0.2) === 30);
check("1.005-style values round, not truncate", totalToPaise(10.07) === 1007);

console.log("\n── decision ──");
const paid = decideSettlement({ capturedPaise: 25000, orderTotal: 250, orderStatus: "placed" });
check("exact amount on a live order is accepted", paid.kind === "accept" && paid.overpaidPaise === 0, paid);

const over = decideSettlement({ capturedPaise: 26000, orderTotal: 250, orderStatus: "placed" });
check("overpayment is accepted and reported", over.kind === "accept" && over.overpaidPaise === 1000, over);

const under = decideSettlement({ capturedPaise: 20000, orderTotal: 250, orderStatus: "placed" });
check("underpayment is held with the shortfall", under.kind === "hold_underpaid" && under.shortfallPaise === 5000, under);

const oneShort = decideSettlement({ capturedPaise: 24999, orderTotal: 250, orderStatus: "placed" });
check("one paisa short is still held", oneShort.kind === "hold_underpaid" && oneShort.shortfallPaise === 1, oneShort);

const cancelled = decideSettlement({ capturedPaise: 25000, orderTotal: 250, orderStatus: "cancelled" });
check("full payment on a cancelled order goes to refund", cancelled.kind === "accept_cancelled", cancelled);

const cancelledUnder = decideSettlement({ capturedPaise: 10000, orderTotal: 250, orderStatus: "cancelled" });
check("underpaid AND cancelled is held, never marked paid", cancelledUnder.kind === "hold_underpaid", cancelledUnder);

const addedItems = decideSettlement({ capturedPaise: 25000, orderTotal: 410, orderStatus: "placed" });
check("items added after the Razorpay order was made are caught", addedItems.kind === "hold_underpaid" && addedItems.shortfallPaise === 16000, addedItems);

for (const status of ["placed", "kitchen", "ready", "on_the_way", "delivered"]) {
  const d = decideSettlement({ capturedPaise: 25000, orderTotal: 250, orderStatus: status });
  check(`status "${status}" is accepted, not refunded`, d.kind === "accept", d);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
