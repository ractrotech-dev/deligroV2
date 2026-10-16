import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit } from "@/lib/rate-limit";
import {
  createOrder,
  listVisibleOrders,
  OrderRefused,
  PaymentRefused,
  type CreateOrderInput,
} from "@/lib/data-access/orders";
import { recordDomain } from "@/lib/obs/emit";
import { obsRequestContext } from "@/lib/obs/request";
import { getLang } from "@/lib/i18n/server";
import { translator } from "@/lib/i18n/lang";

function mapCreateError(message: string) {
  // Coupon refusals are the customer's to act on — retry without the code, or
  // add another ₹80 to clear the minimum — so they keep their own reason
  // rather than collapsing into a generic 400.
  if (message.startsWith("coupon_")) {
    return { status: 400, error: message };
  }

  switch (message) {
    case "unauthorized":
      return { status: 401, error: "unauthorized" };
    case "restaurant_not_found":
    case "restaurant_closed":
    case "empty_cart":
    case "invalid_items":
      return { status: 400, error: message };
    case "tip_unsupported":
      // The database predates migration 0013 and has nowhere to record a tip.
      return { status: 503, error: "tip_unsupported" };
    case "online_payments_unavailable":
      // Switched off, unconfigured, or the database predates 0025. Either way
      // the order is refused rather than silently downgraded to cash.
      return { status: 503, error: "online_payments_unavailable" };
    default:
      return { status: 500, error: "server_error" };
  }
}

/**
 * A PostgREST row-level-security refusal. These arrive as plain objects, not
 * `Error`s, which is why they slipped past the mapping below and surfaced as a
 * generic 500.
 */
function isRlsRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === "42501" ||
    (typeof e.message === "string" &&
      e.message.includes("row-level security policy"))
  );
}

/** GET /api/orders — orders visible to the signed-in user (RLS-scoped). */
export async function GET() {
  if (!isSupabaseConfigured) {
    return NextResponse.json(
      { error: "backend_not_configured" },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`orders-list:${user.id}`, 60, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  try {
    const orders = await listVisibleOrders();
    return NextResponse.json({ orders });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/** POST /api/orders — place an order (customer or admin, server-validated totals). */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json(
      { error: "backend_not_configured" },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`orders-create:${user.id}`, 20, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: CreateOrderInput;
  try {
    body = (await request.json()) as CreateOrderInput;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (
    !body?.restaurantSlug ||
    !Array.isArray(body.lines) ||
    !body.address?.label ||
    !body.address?.line
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Correlation for everything this order touches from here on: the Razorpay
  // order, the webhook that settles it, the dispatch that follows and the push
  // that announces it. The webhook cannot carry this header, so it rejoins the
  // trace through `payments.provider_order_id`.
  const obs = { ...(await obsRequestContext()), actorId: user.id };
  // The customer's language, for the refusal sentences returned below.
  const lang = await getLang();
  const t = translator(lang);

  try {
    const order = await createOrder(body, lang);
    // The series `volume_drop` alerts on. Its absence is the signal — an
    // ordering platform that stops creating orders produces no errors at all,
    // which is why "nothing is wrong" and "nothing is happening" have to be
    // distinguishable, and why this is recorded on the SUCCESS path.
    recordDomain("order.created", "info", "Order placed", {
      ...obs,
      orderId: order?.id,
      attrs: {
        itemCount: body.lines.length,
        paymentMethod: body.paymentMethod,
      },
    });
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    return orderFailure(err, { obs, t, body });
  }
}

/**
 * The response for an order that threw: a refusal the rules wrote a sentence
 * for, the wrong role, a mapped error code, or — recorded loudly — none of those.
 */
function orderFailure(
  err: unknown,
  {
    obs,
    t,
    body,
  }: {
    obs: Awaited<ReturnType<typeof obsRequestContext>> & { actorId: string };
    t: ReturnType<typeof translator>;
    body: CreateOrderInput;
  },
): NextResponse {
  // The cash ceiling is per vendor, so the sentence the customer needs
  // ("Orders above ₹300 must be paid online") can only be written by the
  // rules that refused the order. Pass it through verbatim rather than
  // rebuilding it here from a code and a guess at the number.
  if (err instanceof PaymentRefused) {
    // A refusal is the platform working, not failing — `info`, so it does not
    // land in the issue list. It is still recorded, because a spike in
    // refusals is a business problem worth seeing (a vendor's cash ceiling set
    // too low will refuse every order they get) even though no single one is a
    // bug.
    recordDomain("order.refused", "info", `Order refused: ${err.reason}`, {
      ...obs,
      attrs: { reason: err.reason, refusal: "payment" },
    });
    return NextResponse.json(
      { error: err.reason, message: err.customerMessage },
      { status: 400 },
    );
  }
  // Same shape, same reason: the maintenance message, the configured minimum
  // and the shop's radius are only known to the code that refused. A pause is
  // 503 (try later, nothing about the request was wrong); a basket under the
  // minimum or an address out of area is 400 (the request itself can't stand).
  if (err instanceof OrderRefused) {
    recordDomain("order.refused", "info", `Order refused: ${err.reason}`, {
      ...obs,
      attrs: { reason: err.reason, refusal: "order" },
    });
    return NextResponse.json(
      { error: err.reason, message: err.customerMessage },
      { status: err.reason === "orders_paused" ? 503 : 400 },
    );
  }
  // Postgres 42501 is the row-level security refusal. It is not a server
  // fault and must not be reported as one: "orders — customer insert" admits
  // 'customer' and (since 0040) 'admin', so this is what a driver, vendor or
  // manager account gets when it tries to place an order. Signing in as the
  // wrong role is the likeliest cause and the only one the customer can act
  // on, so say that instead of "try again", which never works.
  //
  // The owner/developer account used to land here too — it is an admin, and
  // admin was not on that list. 0040 put it there: an operator shops through
  // the same app as everyone else, with no second identity to switch to.
  if (isRlsRefusal(err)) {
    // Not a fault, and not silent either: a run of these is a real support
    // pattern ("I can't order from my own app"), and the answer — sign in
    // with the customer account — is only obvious once someone can see that
    // this is what is happening.
    recordDomain(
      "order.refused",
      "warn",
      "Order refused by row-level security — the account is not a customer",
      { ...obs, attrs: { reason: "not_a_customer", code: "42501" } },
    );
    return NextResponse.json(
      {
        error: "not_a_customer",
        message: t(
          "This account can't place orders. Sign in with your customer account and try again.",
          "इस अकाउंट से ऑर्डर नहीं हो सकता। अपने ग्राहक अकाउंट से लॉगिन करके फिर कोशिश करें।",
        ),
      },
      { status: 403 },
    );
  }
  const message = err instanceof Error ? err.message : "server_error";
  const mapped = mapCreateError(message);
  // An unmapped failure is the one case where the customer is told nothing
  // useful ("Could not place the order") — so it is the one case that has to
  // reach the server log, or there is no way to find out what happened. A
  // PostgREST rejection arrives as a plain object, not an Error, and its
  // `message`/`code`/`details` are the whole diagnosis; stringify it rather
  // than logging `err.message`, which is undefined for exactly those.
  if (mapped.error === "server_error") {
    // This branch is the reason the whole system exists: the customer is told
    // "could not place the order", which is true and useless, and until now
    // the only trace of WHY was a console line in a serverless log that
    // expires within the hour. The console.error stays for local development,
    // where it is the fastest signal; the telemetry is what survives.
    console.error(
      "[orders] order refused, unmapped:",
      JSON.stringify(err),
      err,
    );
    recordDomain(
      "order.created",
      "error",
      "Order creation failed with an unmapped error",
      {
        ...obs,
        attrs: { reason: "unmapped", itemCount: body.lines.length },
        error: err,
      },
    );
  }
  return NextResponse.json(
    { error: mapped.error },
    { status: mapped.status },
  );
}
