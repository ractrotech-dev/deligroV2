/**
 * QA — the payment rules checkout and the order API both decide from
 * (src/lib/payments/cod-rules.ts), and the platform cash limit (rule book,
 * "Payment methods"). Usage: npx tsx scripts/qa/payment-rules.ts
 */
import {
  codLimitHint,
  paymentAvailability,
  refusalMessage,
  refusePayment,
  strictestCashLimit,
} from "../../src/lib/payments/cod-rules";

let fails = 0;
const ok = (c: boolean, m: string, extra = "") => {
  if (c) console.log(`ok   ${m}`);
  else {
    fails++;
    console.log(`FAIL ${m}${extra ? " — " + extra : ""}`);
  }
};

// The stricter limit, and 0 meaning "not set".
ok(strictestCashLimit(0, 0) === 0, "no limit on either side is no limit");
ok(strictestCashLimit(0, 300) === 300, "a shop at 0 uses the platform limit");
ok(strictestCashLimit(500, 0) === 500, "a platform at 0 leaves the shop's limit");
ok(strictestCashLimit(500, 300) === 300, "the platform is stricter");
ok(strictestCashLimit(200, 300) === 200, "the shop is stricter");

const cashOnly = { acceptCod: true, acceptOnline: false, codMaxOrder: 500 };
const both = { acceptCod: true, acceptOnline: true, codMaxOrder: 500 };

// Under and at the limit.
ok(paymentAvailability(cashOnly, 500).cod, "exactly the limit is still cash");
ok(refusePayment(cashOnly, "cod", 500) === null, "the API accepts exactly the limit");
ok(codLimitHint(cashOnly, 400) !== null, "cash under the limit gets a heads-up");

// Above the limit, online on: online only.
{
  const a = paymentAvailability(both, 501);
  ok(!a.cod && a.online && !a.noMethod, "above the limit with online on: online only");
  ok(a.notice === "Orders above ₹500 must be paid online.", "and the customer is told so", String(a.notice));
  ok(refusePayment(both, "cod", 501) === "cod_limit_exceeded", "the API refuses cash");
  ok(refusePayment(both, "online", 501) === null, "the API takes online");
}

// Above the limit, online off: the case the owner has to know about.
{
  const a = paymentAvailability(cashOnly, 501);
  ok(a.noMethod, "above the limit with online off: checkout is blocked");
  ok(
    a.notice?.startsWith("Orders above ₹500 can't be placed right now.") === true,
    "and says so plainly, not 'this shop cannot take payment'",
    String(a.notice),
  );
  const code = refusePayment(cashOnly, "cod", 501);
  ok(code === "cod_limit_exceeded", "the API refuses with the limit code", String(code));
  ok(
    refusalMessage("cod_limit_exceeded", cashOnly).startsWith("Orders above ₹500 can't be placed right now."),
    "and the same sentence",
  );
  ok(
    refusalMessage("cod_limit_exceeded", both) === "Orders above ₹500 must be paid online.",
    "the online sentence is only used when online is on",
  );
}

// Cash off platform-wide reaches a shop as acceptCod: false.
{
  const onlineOnly = { acceptCod: false, acceptOnline: true, codMaxOrder: 0 };
  ok(paymentAvailability(onlineOnly, 100).online && !paymentAvailability(onlineOnly, 100).cod, "cash off, online on: online only");
  ok(refusePayment(onlineOnly, "cod", 100) === "cod_not_available", "the API refuses cash");
  const nothing = { acceptCod: false, acceptOnline: false, codMaxOrder: 0 };
  ok(paymentAvailability(nothing, 100).noMethod, "nothing on offer blocks checkout");
  ok(refusePayment(nothing, "cod", 100) === "no_payment_method", "and the API refuses");
}

console.log(fails ? `\n${fails} check(s) failed` : "\nAll payment rule checks passed.");
process.exit(fails ? 1 : 0);
