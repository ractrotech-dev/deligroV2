/**
 * QA — the developer's platform lock (0177): who it closes out, what the
 * paused screen says, and that the Admin console, the Manager API and the
 * order path all honour it.
 * Usage: npx tsx scripts/qa/platform-lock.ts
 */
import { readFileSync } from "node:fs";
import { isLockLevel, lockBlocksConsole, pausedText } from "../../src/lib/platform-lock-rules";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const full = { level: "full" as const, message: "" };
const orders = { level: "orders" as const, message: "Back on Monday" };
check("full closes the Admin console", lockBlocksConsole(full, "admin"));
check("full closes the Manager app", lockBlocksConsole(full, "manager"));
check("the developer is never locked out", !lockBlocksConsole(full, "developer"));
check("shops and riders are not locked out (they finish open orders)", !lockBlocksConsole(full, "restaurant") && !lockBlocksConsole(full, "driver"));
check("stopping orders leaves the consoles open", !lockBlocksConsole(orders, "admin") && !lockBlocksConsole(orders, "manager"));
check("off closes nothing", !lockBlocksConsole({ level: "off", message: "" }, "admin"));
check("the paused screen shows the developer's message", pausedText(orders) === "Back on Monday");
check("...or says who paused it", /platform developer/.test(pausedText(full)));
check("only off, orders and full are levels", isLockLevel("off") && isLockLevel("full") && !isLockLevel("everything") && !isLockLevel(null));

const auth = readFileSync("src/lib/auth.ts", "utf8");
check("requireRole sends admin and manager to /paused under a full pause", auth.includes("lockBlocksConsole(") && auth.includes('redirect("/paused")'));
const api = readFileSync("src/lib/auth/manager-api.server.ts", "utf8");
check("the Manager API answers 423 platform_paused", api.includes('"platform_paused"') && api.includes("status: 423"));
const action = readFileSync("src/app/developer/operations/actions.ts", "utf8");
check("only a developer can change it", action.includes('requireRole("developer")'));
const orderPath = readFileSync("src/lib/data-access/orders.ts", "utf8");
check("checkout refuses while ordering is off (the lock turns it off)", orderPath.includes("settings.acceptingOrders"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
