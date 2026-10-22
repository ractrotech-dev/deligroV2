import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatINR } from "@/lib/utils/format";
import type { PushOptions, PushText } from "./onesignal";
import { notifyUser, notifyUsers, pushTransport } from "./notify-user";
import { ringStartData, ringStopData, riderRingPush, RING_TIMEOUT_SEC } from "@/lib/alerts/ring";
import { exceptionLabel, isRequestKind, type ExceptionKind } from "@/lib/rider/exception-rules";
import type { NotificationCategory } from "@/lib/rider/notification-prefs";
import { formatDay } from "@/lib/rider/admin-money";

/**
 * Order notifications — every transition, for every side of it.
 *
 * This file used to cover two of six transitions: on-the-way and delivered. A
 * customer heard nothing when the restaurant accepted their order, nothing when
 * it was ready, and — worst of the set — nothing when it was rejected. The two
 * moments people actually wait for were the silent ones.
 *
 * Everything here never throws into the caller. A failed push must not roll
 * back the transition that triggered it; an order that moved and wasn't
 * announced is recoverable, an order that didn't move is not. Callers schedule
 * these with `deferNotify()` (./defer.ts) rather than `void`, so the send
 * survives the end of a serverless invocation.
 *
 * Recipients are addressed by profile id first — the OneSignal `external_id`
 * set by `OneSignal.login()` in every portal — with the stored
 * `profiles.onesignal_id` as a fallback for devices that subscribed before
 * login existed. Reads use the service-role client because the contexts that
 * trigger these — a driver advancing a delivery, a webhook, a vendor accepting
 * — cannot see the counterparty's push id under RLS.
 *
 * Copy is English + Hindi; OneSignal shows the one matching the device. Rider
 * copy is English only (owner decision for the rider side).
 *
 * ## Rider pushes go through `notifyUser` (Phase 7)
 *
 * Every push a rider receives is also a row in their inbox
 * (`user_notifications`) and carries a category (`lib/rider/notification-
 * prefs.ts`), which the rider may switch off — except offers, cancellations
 * and safety. `notifyRider` below is the only rider path; ring STOP signals
 * (`stopRiderRing`) stay raw: silent, nothing to read, no inbox row.
 *
 * Every send goes through `pushTransport` (notify-user.ts), so the QA script
 * can record pushes without sending any.
 */

async function pushToUser(
  userId: string | null | undefined,
  playerId: string | null | undefined,
  heading: PushText,
  message: PushText,
  url: string,
  opts: PushOptions = {}
): Promise<void> {
  if (!userId && !playerId) return;
  try {
    await pushTransport.send({ userIds: [userId], playerIds: [playerId] }, heading, message, { url, ...opts });
  } catch {
    // swallow — fire-and-forget
  }
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

type PushProfile = { id: string; onesignal_id: string | null };

/** Push an order update to the order's customer. */
async function notifyCustomer(
  orderId: string,
  heading: PushText,
  message: PushText
): Promise<void> {
  if (!pushTransport.configured()) return;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("orders")
      .select("customer:profiles!orders_customer_id_fkey(id, onesignal_id)")
      .eq("id", orderId)
      .maybeSingle();

    const customer = one(data?.customer as PushProfile | PushProfile[] | null);
    await pushToUser(
      customer?.id,
      customer?.onesignal_id,
      heading,
      message,
      `/orders/${orderId}`
    );
  } catch {
    // swallow — fire-and-forget
  }
}

/**
 * Push to the owner of the restaurant an order was placed with.
 *
 * The vendor board polls every eight seconds, which is fine when someone is
 * watching it and useless when nobody is. A new order is the one event a
 * kitchen cannot afford to discover late.
 */
async function notifyVendor(
  orderId: string,
  heading: PushText,
  message: PushText,
  opts: PushOptions = {}
): Promise<void> {
  if (!pushTransport.configured()) return;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("orders")
      .select("restaurants(owner_id)")
      .eq("id", orderId)
      .maybeSingle();

    const restaurant = one(
      data?.restaurants as { owner_id: string | null } | { owner_id: string | null }[] | null
    );
    if (!restaurant?.owner_id) return;

    const { data: owner } = await supabase
      .from("profiles")
      .select("onesignal_id")
      .eq("id", restaurant.owner_id)
      .maybeSingle();

    await pushToUser(restaurant.owner_id, owner?.onesignal_id, heading, message, `/vendor`, opts);
  } catch {
    // swallow — fire-and-forget
  }
}

/**
 * A RAW push to one rider, by profile id — no inbox row, no category. Only for
 * the silent ring stop (`stopRiderRing`); everything a rider can read goes
 * through `notifyRider`.
 */
async function notifyDriver(
  driverId: string,
  heading: PushText,
  message: PushText,
  opts: PushOptions = {}
): Promise<void> {
  if (!pushTransport.configured()) return;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("profiles")
      .select("onesignal_id")
      .eq("id", driverId)
      .maybeSingle();

    await pushToUser(driverId, data?.onesignal_id, heading, message, "/driver", opts);
  } catch {
    // swallow — fire-and-forget
  }
}

/** The OneSignal `url` for a rider push: the web portal (web push opens it). The app routes on `data.url`. */
const RIDER_WEB = "/driver";

/**
 * Tell one rider something: an inbox row and — unless they switched the
 * category off — a push (`notifyUser`). Takes the recipient directly: dispatch
 * has already decided who to ask (see rider-dispatch.ts), and looking the
 * rider back up from the order would mean reading a `driver_id` that is
 * deliberately still null while an offer is outstanding.
 *
 * `url` is the rider app's route for a tap (jobs, ticket, earnings, …), sent
 * as `data.url` and stored on the inbox row.
 */
async function notifyRider(
  driverId: string,
  category: NotificationCategory,
  heading: PushText,
  message: PushText,
  opts: { url: string; data?: Record<string, unknown>; push?: PushOptions }
): Promise<void> {
  try {
    await notifyUser({
      userId: driverId,
      role: "rider",
      category,
      title: heading.en,
      body: message.en,
      url: opts.url,
      data: opts.data,
      pushOptions: { ...opts.push, url: RIDER_WEB },
    });
  } catch {
    // swallow — fire-and-forget
  }
}

/**
 * Push to everyone running operations: admins and managers.
 *
 * For the two failures nobody on the order is placed to notice — a kitchen that
 * hasn't accepted, an order with no rider — which the admin board only shows to
 * someone already looking at it. See lib/dispatch/sweep.ts.
 */
async function notifyOps(
  heading: PushText,
  message: PushText,
  url: string,
  opts: PushOptions = {}
): Promise<void> {
  await opsPush(heading, message, url, opts);
}

/** `notifyOps`, answering whether the push reached anyone (false when push is not configured). */
async function opsPush(
  heading: PushText,
  message: PushText,
  url: string,
  opts: PushOptions = {}
): Promise<boolean> {
  if (!pushTransport.configured()) return false;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("profiles")
      .select("id, onesignal_id")
      .in("role", ["admin", "manager"]);
    const ops = (data ?? []) as PushProfile[];
    if (ops.length === 0) return false;
    return await pushTransport.send(
      { userIds: ops.map((p) => p.id), playerIds: ops.map((p) => p.onesignal_id) },
      heading,
      message,
      { url, ...opts }
    );
  } catch {
    // swallow — fire-and-forget
    return false;
  }
}

/* ---------- ringing (lib/alerts/ring.ts) ---------- */

/**
 * High priority: Android only lets the Vendor/Rider app start its ringing
 * service from a high-priority message. The ttl matches the ring's own
 * timeout — a phone that comes online after that has nothing left to ring for.
 */
const vendorRing = (orderId: string): PushOptions => ({
  priority: 10,
  ttlSec: RING_TIMEOUT_SEC.vendor,
  data: { ...ringStartData("vendor", orderId) },
});
/**
 * `held`: the order is held for this rider right now (the ring then ignores
 * their sound and vibration switches); false for a heads-up. `windowSeconds`:
 * the live `rider_offer_window_seconds`, which sets the ring's length and ttl.
 */
const riderRing = (orderId: string, opts: { held: boolean; windowSeconds?: number }): PushOptions => {
  const ring = riderRingPush(orderId, opts);
  return { priority: ring.priority, ttlSec: ring.ttlSec, data: { ...ring.data } };
};

/**
 * Every phone signed in to the restaurant stops ringing for this order —
 * accepted on the counter tablet silences the owner's phone too. Silent: it
 * shows nothing anywhere, including web push and APKs without the ring.
 *
 * Normal priority, deliberately: FCM may downgrade an app's high-priority
 * messages when they produce no visible notification, and the ring STARTS
 * depend on high priority. A ringing phone runs a foreground service, so a
 * stop delivered at normal priority still lands; the open board and the
 * ring's own timeout cover the rest.
 */
export function stopVendorRing(orderId: string): Promise<void> {
  return notifyVendor(orderId, { en: "" }, { en: "" }, {
    silent: true,
    data: { ...ringStopData("vendor", orderId) },
  });
}

export function stopRiderRing(driverId: string, orderId: string): Promise<void> {
  return notifyDriver(driverId, { en: "" }, { en: "" }, {
    silent: true,
    data: { ...ringStopData("rider", orderId) },
  });
}

/* ---------- customer-facing transitions ---------- */

/**
 * Placed — deliberately worded as *sent*, not accepted. The order is waiting on
 * the kitchen at this point and saying otherwise is the lie the tracker used
 * to tell.
 */
export function notifyOrderPlaced(orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Order sent 🧾", hi: "ऑर्डर भेजा गया 🧾" },
    {
      en: `Order #${id} is with the restaurant. We'll tell you the moment they accept.`,
      hi: `ऑर्डर #${id} रेस्टोरेंट को भेज दिया गया है। जैसे ही वे स्वीकार करेंगे, हम आपको बताएंगे।`,
    }
  );
}

export function notifyOrderAccepted(
  orderId: string,
  restaurantName?: string
): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Order accepted 👨‍🍳", hi: "ऑर्डर स्वीकार हुआ 👨‍🍳" },
    restaurantName
      ? {
          en: `${restaurantName} accepted order #${id} and started cooking.`,
          hi: `${restaurantName} ने ऑर्डर #${id} स्वीकार कर लिया है और खाना बनना शुरू हो गया है।`,
        }
      : {
          en: `Order #${id} was accepted and is being cooked.`,
          hi: `ऑर्डर #${id} स्वीकार हो गया है और खाना बन रहा है।`,
        }
  );
}

export function notifyOrderReady(orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Food is ready 🍽️", hi: "खाना तैयार है 🍽️" },
    {
      en: `Order #${id} is packed and waiting for a rider.`,
      hi: `ऑर्डर #${id} पैक हो गया है और राइडर का इंतज़ार कर रहा है।`,
    }
  );
}

export function notifyOnTheWay(orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Your order is on the way 🛵", hi: "आपका ऑर्डर रास्ते में है 🛵" },
    {
      en: `Order #${id} has left the kitchen and is heading to you.`,
      hi: `ऑर्डर #${id} किचन से निकल चुका है और आपकी ओर आ रहा है।`,
    }
  );
}

export function notifyDelivered(orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Delivered ✅", hi: "डिलीवर हो गया ✅" },
    {
      en: `Order #${id} was delivered. Enjoy your meal!`,
      hi: `ऑर्डर #${id} डिलीवर हो गया। खाने का आनंद लें!`,
    }
  );
}

/**
 * Cancelled. `byVendor` changes the wording because the two cases are not the
 * same message: a customer who cancelled knows why, and one whose order the
 * restaurant refused needs to be told plainly — and told about their money.
 */
export function notifyOrderCancelled(
  orderId: string,
  opts: { byVendor?: boolean; refundQueued?: boolean } = {}
): Promise<void> {
  const id = shortOrderId(orderId);
  const moneyEn = opts.refundQueued
    ? " Your refund has been requested and is being processed."
    : "";
  const moneyHi = opts.refundQueued
    ? " आपका रिफ़ंड अनुरोध दर्ज हो गया है और प्रोसेस हो रहा है।"
    : "";
  return notifyCustomer(
    orderId,
    opts.byVendor
      ? { en: "Order declined", hi: "ऑर्डर अस्वीकार हुआ" }
      : { en: "Order cancelled", hi: "ऑर्डर रद्द हुआ" },
    opts.byVendor
      ? {
          en: `The restaurant couldn't take order #${id}.${moneyEn}`,
          hi: `रेस्टोरेंट ऑर्डर #${id} नहीं ले सका।${moneyHi}`,
        }
      : {
          en: `Order #${id} was cancelled.${moneyEn}`,
          hi: `ऑर्डर #${id} रद्द कर दिया गया।${moneyHi}`,
        }
  );
}

export function notifyPaymentFailed(orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    { en: "Payment didn't go through", hi: "भुगतान नहीं हो पाया" },
    {
      en: `Order #${id} is saved but unpaid. Open it to try again.`,
      hi: `ऑर्डर #${id} सेव है लेकिन भुगतान बाकी है। दोबारा कोशिश करने के लिए इसे खोलें।`,
    }
  );
}

export function notifyRefundDecided(
  orderId: string,
  approved: boolean
): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyCustomer(
    orderId,
    approved
      ? { en: "Refund approved 💸", hi: "रिफ़ंड मंज़ूर 💸" }
      : { en: "Refund declined", hi: "रिफ़ंड अस्वीकार" },
    approved
      ? {
          en: `Your refund for order #${id} was approved.`,
          hi: `ऑर्डर #${id} का आपका रिफ़ंड मंज़ूर हो गया है।`,
        }
      : {
          en: `We couldn't approve the refund for order #${id}. Contact support if this looks wrong.`,
          hi: `हम ऑर्डर #${id} का रिफ़ंड मंज़ूर नहीं कर सके। अगर यह गलत लगे तो सपोर्ट से संपर्क करें।`,
        }
  );
}

/* ---------- rider-facing ---------- */

/**
 * The kitchen just accepted — go and be there when it comes off the pass.
 *
 * This is the notification the rider never used to get. Orders appeared in the
 * available pool at `ready`, which is the moment the food is already sitting on
 * the counter going cold: the road leg started from wherever the rider happened
 * to be, after they happened to notice. Told at `kitchen` instead, with the
 * prep estimate, a rider can be at the shop when the bag is.
 *
 * `readyInMinutes` is the kitchen leg from `kitchenPrepMinutes` — the same
 * number the customer's countdown is built on, so the two cannot disagree.
 */
export function notifyDriverPickupOffered(
  driverId: string,
  opts: {
    orderId: string;
    restaurantName: string;
    readyInMinutes: number;
    /** Shown so the rider can judge whether to set off now. */
    pickupArea?: string | null;
    /** The live offer window (seconds), for the ring's length. */
    windowSeconds?: number;
  }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  const where = opts.pickupArea?.trim() ? ` (${opts.pickupArea.trim()})` : "";
  return notifyRider(
    driverId,
    "offers",
    { en: "Pickup coming your way 🛵" },
    { en: `${opts.restaurantName}${where} is cooking order #${id} — ready in about ${opts.readyInMinutes} min. Head over.` },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId }, push: riderRing(opts.orderId, { held: false, windowSeconds: opts.windowSeconds }) }
  );
}

/** Packed and waiting. Sent to whichever rider dispatch picked at ready-time. */
export function notifyDriverPickupReady(
  driverId: string,
  opts: {
    orderId: string;
    restaurantName: string;
    /** Whether the order is now held for this rider (their offer was written). */
    held: boolean;
    /** The live offer window (seconds), for the ring's length. */
    windowSeconds?: number;
  }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "offers",
    { en: "Order ready to collect 📦" },
    { en: `${opts.restaurantName} has packed order #${id}. It's held for you — accept it in the app.` },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId }, push: riderRing(opts.orderId, { held: opts.held, windowSeconds: opts.windowSeconds }) }
  );
}

/**
 * A manager put this rider on the order by hand. Without this the rider only
 * found out on their next board refresh — which, with the phone in a pocket,
 * is whenever they next looked.
 *
 * Does not ring: an assignment is an instruction, not an offer. There is no
 * Accept step that could stop the ring, so it would ring out its full timeout
 * whatever the rider did.
 */
export function notifyDriverAssigned(
  driverId: string,
  opts: { orderId: string; restaurantName: string }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "offers",
    { en: "New delivery assigned 🛵" },
    { en: `You've been assigned order #${id} from ${opts.restaurantName}. Open the app for pickup details.` },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId } }
  );
}

/**
 * The order this rider was offered or carrying is off. A rider already riding
 * to the shop used to keep riding until they looked at the screen.
 */
export async function notifyDriverOrderCancelled(
  driverId: string,
  opts: { orderId: string; pickedUp: boolean }
): Promise<void> {
  await stopRiderRing(driverId, opts.orderId);
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "cancellations",
    { en: "Order cancelled ✋" },
    opts.pickedUp
      ? { en: `Order #${id} was cancelled. If you already have the food, contact support.` }
      : { en: `Order #${id} was cancelled. Don't pick it up.` },
    { url: "/jobs", data: { orderId: opts.orderId } }
  );
}

/**
 * A manager or admin handed the order to a rider by hand (`assignRider`)
 * while dispatch's offer was out. The rider the offer was out to stops
 * ringing either way; if the order went to SOMEONE ELSE they are also told —
 * an inbox row and a push in `cancellations`, the category riders cannot mute
 * — so a phone in a pocket does not ring on for an order that is gone, and a
 * rider already heading over turns back. The assignee themselves gets
 * `notifyDriverAssigned` from the caller; here only their now-pointless offer
 * ring is stopped.
 */
export async function notifyOffereeOfHandAssignment(
  orderId: string,
  opts: { offeredDriverId: string | null | undefined; assignedRiderId: string }
): Promise<void> {
  const offeree = opts.offeredDriverId;
  if (!offeree) return;
  await stopRiderRing(offeree, orderId);
  if (offeree === opts.assignedRiderId) return;
  const id = shortOrderId(orderId);
  await notifyRider(
    offeree,
    "cancellations",
    { en: "Order given to another rider" },
    { en: `Order #${id} was assigned to another rider. You don't need to pick it up.` },
    { url: "/jobs", data: { orderId, reason: "reassigned" } }
  );
}

/**
 * The rider is at the door.
 *
 * Fired once, from the rider's own location report, when they first come within
 * the arrival radius of the drop (see reportDriverLocation). Worded as *nearly*
 * there rather than *here*: 500 m is a couple of minutes on a bike, and a
 * customer who comes downstairs on this message should not be standing in the
 * street for five minutes wondering whether they misread it.
 */
export function notifyRiderArriving(orderId: string, riderName?: string | null): Promise<void> {
  const id = shortOrderId(orderId);
  const name = riderName?.trim();
  return notifyCustomer(
    orderId,
    { en: "Your rider is here 🛵", hi: "आपका राइडर पहुँच गया 🛵" },
    {
      en: `${name || "Your rider"} has reached your place with order #${id}. Have your delivery code ready.`,
      hi: `${name || "आपके राइडर"} ऑर्डर #${id} लेकर आपके पते पर पहुँच गए हैं। अपना डिलीवरी कोड तैयार रखें।`,
    }
  );
}

/**
 * The rider tapped "Arrived" at the customer's door — the second and final
 * notice after the 500 m `notifyRiderArriving`, and the one that is literally
 * true. Sent once: the step it follows is set-once (`arrived_drop_at`), and a
 * replayed tap is answered as a duplicate without reaching here.
 */
export function notifyRiderArrived(orderId: string, riderName?: string | null): Promise<void> {
  const id = shortOrderId(orderId);
  const name = riderName?.trim();
  return notifyCustomer(
    orderId,
    { en: "Your rider has arrived 🛵", hi: "आपका राइडर पहुँच गया है 🛵" },
    {
      en: `${name || "Your rider"} is at your door with order #${id}. Have your delivery code ready.`,
      hi: `${name || "आपके राइडर"} ऑर्डर #${id} लेकर आपके दरवाज़े पर हैं। अपना डिलीवरी कोड तैयार रखें।`,
    }
  );
}

/**
 * The shop confirmed it handed this rider the order ("Handed to rider" on the
 * vendor board), which records the pickup for them. Rider copy is English only
 * (owner decision for the rider side).
 */
export function notifyRiderHandedOver(driverId: string, orderId: string): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyRider(
    driverId,
    "delivery_updates",
    { en: "Pickup confirmed by the shop" },
    { en: `The shop handed you order #${id}. Head to the customer.` },
    { url: `/jobs/${orderId}`, data: { orderId } }
  );
}

/** Rupees for a push: whole amounts plain, anything else to the paisa ("₹40.50"). */
function rupeesText(amount: number): string {
  return Number.isInteger(amount)
    ? formatINR(amount)
    : `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * An incentive target was reached (`rider_incentive_awards`, 0083). Sent by
 * `notifyNewIncentiveAwards` once per award. Riders are salaried and paid
 * outside the app, so the copy describes what was RECORDED on their ledger —
 * never a transfer the app made.
 */
export function notifyRiderIncentiveEarned(
  driverId: string,
  award: { name: string; amount: number }
): Promise<void> {
  return notifyRider(
    driverId,
    "incentives",
    { en: "Incentive earned" },
    { en: `${award.name}: a ${rupeesText(award.amount)} incentive was recorded for you.` },
    { url: "/earnings/incentives" }
  );
}

/**
 * An admin recorded a payout to the rider (`record_rider_payout`, 0083). The
 * money moved outside the app (salary model); this reports the ledger entry.
 * Sent by `announcePayoutRecorded` (admin-riders.ts) once the payout row is
 * committed. `periodEnd` is the last day the payout settles (YYYY-MM-DD).
 */
export function notifyRiderPayoutRecorded(
  driverId: string,
  payout: { amount: number; reference: string | null; periodEnd?: string | null }
): Promise<void> {
  const ref = payout.reference?.trim() ? ` Reference: ${payout.reference.trim()}.` : "";
  const period = payout.periodEnd ? ` for work up to ${formatDay(payout.periodEnd)}` : "";
  return notifyRider(
    driverId,
    "payouts",
    { en: "Payout recorded" },
    { en: `Payout recorded: ${rupeesText(payout.amount)}${period}.${ref}` },
    { url: "/earnings/payouts", data: { kind: "payout" } }
  );
}

/* ---------- rider cash (rider-cash.ts, 0085) ---------- */

/**
 * The rider is holding too much cash, or has held it too long
 * (`platform_settings.rider_cash_limit` / `rider_cash_max_hours`). Sent by the
 * dispatch sweep, at most once every 6 hours per rider. English only.
 */
export function notifyRiderCashReminder(
  driverId: string,
  cash: { pending: number; reason: "limit" | "hours" | "both"; hours: number }
): Promise<void> {
  const why =
    cash.reason === "limit"
      ? "That is over your cash limit."
      : cash.reason === "hours"
        ? `Some of it is more than ${cash.hours} hours old.`
        : `That is over your cash limit and some of it is more than ${cash.hours} hours old.`;
  return notifyRider(
    driverId,
    "cash",
    { en: "Deposit your cash" },
    { en: `You are holding ${rupeesText(cash.pending)} of Deligro cash. ${why} Hand it to a manager and declare the deposit in the app.` },
    { url: "/more/cash" }
  );
}

/** A manager confirmed or disputed the rider's deposit. English only. */
export function notifyRiderDepositDecided(
  driverId: string,
  opts: { amount: number; status: "confirmed" | "disputed"; note?: string | null }
): Promise<void> {
  const note = opts.note?.trim() ? ` Note: ${opts.note.trim()}` : "";
  return notifyRider(
    driverId,
    "cash",
    { en: opts.status === "confirmed" ? "Deposit confirmed" : "Deposit disputed" },
    {
      en:
        opts.status === "confirmed"
          ? `Your deposit of ${rupeesText(opts.amount)} was confirmed.`
          : `Your deposit of ${rupeesText(opts.amount)} was disputed.${note} Speak to the manager.`,
    },
    { url: "/more/cash" }
  );
}

/** A rider declared a deposit: tell every manager and admin there is one to confirm. */
export function notifyOpsDepositSubmitted(opts: {
  riderName?: string | null;
  amount: number;
  method: "cash" | "upi";
}): Promise<void> {
  const who = opts.riderName?.trim() || "A rider";
  return notifyOps(
    { en: "Rider cash deposit to confirm" },
    { en: `${who} says they handed over ${rupeesText(opts.amount)} (${opts.method === "upi" ? "UPI" : "cash"}). Confirm it on the cash page.` },
    "/manager/cash"
  );
}

const DOC_LABEL: Record<string, string> = {
  aadhaar: "Aadhaar",
  pan: "PAN card",
  driving_licence: "driving licence",
  vehicle_rc: "vehicle RC",
  insurance: "insurance",
  puc: "PUC certificate",
  photo: "photo",
};

/**
 * One of the rider's documents expires in 30, 7 or 1 days, or has expired
 * (0086, `sendDocumentExpiryReminders`, once per stage). English only.
 */
export function notifyRiderDocumentExpiring(
  driverId: string,
  doc: { type: string; daysLeft: number }
): Promise<void> {
  const label = DOC_LABEL[doc.type] ?? "document";
  const when =
    doc.daysLeft < 0 ? "has expired" : doc.daysLeft === 0 ? "expires today" : doc.daysLeft === 1 ? "expires tomorrow" : `expires in ${doc.daysLeft} days`;
  return notifyRider(
    driverId,
    "documents",
    { en: doc.daysLeft < 0 ? "Document expired" : "Document expiring" },
    { en: `Your ${label} ${when}. Upload the new one in Profile & documents.` },
    { url: "/more/profile", data: { type: "rider_document", docType: doc.type } }
  );
}

/**
 * An admin decided something about the rider's profile (0086): a document,
 * a change request, or their verification. English only; the note, if any, is
 * the admin's own words.
 */
export function notifyRiderProfileDecision(
  driverId: string,
  d:
    | { kind: "document"; docType: string; status: "verified" | "rejected"; note?: string | null }
    | { kind: "change"; field: string; status: "approved" | "rejected"; note?: string | null }
    | { kind: "verification"; status: "verified" | "rejected"; note?: string | null }
): Promise<void> {
  const note = d.note?.trim() ? ` ${d.note.trim()}` : "";
  let heading: string;
  let message: string;
  if (d.kind === "document") {
    const label = DOC_LABEL[d.docType] ?? "document";
    heading = d.status === "verified" ? "Document verified" : "Document not accepted";
    message = d.status === "verified" ? `Your ${label} is verified.` : `Your ${label} was not accepted. Upload it again.${note}`;
  } else if (d.kind === "change") {
    const label = { full_name: "name", licence: "licence details", vehicle: "vehicle details", payout_account: "payout account" }[d.field] ?? "profile";
    heading = d.status === "approved" ? "Change approved" : "Change not approved";
    message = d.status === "approved" ? `Your new ${label} is saved.${note}` : `Your ${label} change was not approved.${note}`;
  } else {
    heading = d.status === "verified" ? "You're verified" : "Verification not approved";
    message = d.status === "verified" ? "Deligro has verified your profile and documents." : `Deligro could not verify your profile.${note}`;
  }
  return notifyRider(driverId, "documents", { en: heading }, { en: message }, { url: "/more/profile", data: { type: "rider_profile" } });
}

/* ---------- vendor-facing ---------- */

export function notifyVendorNewOrder(
  orderId: string,
  itemCount?: number
): Promise<void> {
  const id = shortOrderId(orderId);
  const hasCount = typeof itemCount === "number" && itemCount > 0;
  let itemsEn = "";
  if (hasCount) itemsEn = ` · ${itemCount} item${itemCount > 1 ? "s" : ""}`;
  const itemsHi = hasCount ? ` · ${itemCount} आइटम` : "";
  return notifyVendor(
    orderId,
    { en: "New order 🔔", hi: "नया ऑर्डर 🔔" },
    {
      en: `Order #${id}${itemsEn} is waiting for you to accept.`,
      hi: `ऑर्डर #${id}${itemsHi} आपके स्वीकार करने का इंतज़ार कर रहा है।`,
    },
    vendorRing(orderId)
  );
}

/**
 * The customer pulled out. The board would otherwise just drop the card, which
 * a kitchen already cooking has no way to notice.
 */
export async function notifyVendorOrderCancelled(
  orderId: string,
  opts: { byAdmin?: boolean } = {}
): Promise<void> {
  await stopVendorRing(orderId);
  const id = shortOrderId(orderId);
  // Who pulled the order changes what the kitchen does next: a customer
  // cancelling is routine, support cancelling on their behalf usually means
  // something went wrong that the restaurant is about to be asked about.
  return notifyVendor(
    orderId,
    opts.byAdmin
      ? { en: "Order cancelled by support", hi: "सपोर्ट ने ऑर्डर रद्द किया" }
      : { en: "Order cancelled by customer", hi: "ग्राहक ने ऑर्डर रद्द किया" },
    {
      en: `Order #${id} was cancelled. Stop preparing it.`,
      hi: `ऑर्डर #${id} रद्द हो गया है। इसे बनाना बंद करें।`,
    }
  );
}

/** A rider has taken the order — the kitchen knows who to hand the bag to. */
export function notifyVendorRiderAssigned(
  orderId: string,
  riderName?: string | null
): Promise<void> {
  const id = shortOrderId(orderId);
  const name = riderName?.trim();
  return notifyVendor(
    orderId,
    { en: "Rider on the way to you 🛵", hi: "राइडर आ रहा है 🛵" },
    {
      en: `${name || "A rider"} is picking up order #${id}.`,
      hi: `${name || "एक राइडर"} ऑर्डर #${id} लेने आ रहे हैं।`,
    }
  );
}

/* ---------- operations ---------- */

export function notifyOpsKitchenSlow(
  orderId: string,
  opts: { restaurantName: string; minutes: number }
): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyOps(
    { en: "Kitchen hasn't accepted ⏱️", hi: "किचन ने स्वीकार नहीं किया ⏱️" },
    {
      en: `Order #${id} at ${opts.restaurantName} has waited ${opts.minutes} min without being accepted. Call the shop.`,
      hi: `${opts.restaurantName} पर ऑर्डर #${id} ${opts.minutes} मिनट से स्वीकार नहीं हुआ। दुकान को कॉल करें।`,
    },
    `/admin/orders/${orderId}`
  );
}

export function notifyOpsStuck(
  orderId: string,
  opts: { restaurantName: string; hours: number; status: string }
): Promise<void> {
  const id = shortOrderId(orderId);
  const stage = opts.status.replace(/_/g, " ");
  return notifyOps(
    { en: "Order stuck — close it out 🧹", hi: "ऑर्डर अटका है — बंद करें 🧹" },
    {
      en: `Order #${id} at ${opts.restaurantName} has been "${stage}" for ${opts.hours} h. Deliver or cancel it so the customer isn't left waiting.`,
      hi: `${opts.restaurantName} पर ऑर्डर #${id} ${opts.hours} घंटे से "${stage}" है। डिलीवर या रद्द करें।`,
    },
    `/admin/orders/${orderId}`
  );
}

export function notifyOpsNoRider(
  orderId: string,
  opts: { restaurantName: string; minutes: number }
): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyOps(
    { en: "No rider yet 🚨", hi: "अभी तक कोई राइडर नहीं 🚨" },
    {
      en: `Order #${id} at ${opts.restaurantName} has been ready ${opts.minutes} min with no rider. Assign one.`,
      hi: `${opts.restaurantName} पर ऑर्डर #${id} ${opts.minutes} मिनट से तैयार है, कोई राइडर नहीं। किसी को असाइन करें।`,
    },
    "/manager"
  );
}

/* ---------- delivery exceptions (delivery-exceptions.ts) ---------- */

/**
 * A rider asked ops for a decision (or reported something): push every
 * manager and admin, and for a REQUEST ring their phones with the ring id
 * `ops:<exceptionId>` — a rider standing at a door is waiting on the answer.
 * A report is told, not rung. The ring stops on the decision (`stopOpsRing`)
 * or after RING_TIMEOUT_SEC.ops.
 */
export function notifyOpsExceptionRequested(
  exceptionId: string,
  opts: { orderId: string; kind: ExceptionKind; riderName?: string | null }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  const who = opts.riderName?.trim() || "A rider";
  const label = exceptionLabel(opts.kind);
  const request = isRequestKind(opts.kind);
  return notifyOps(
    request
      ? { en: `Rider needs a decision: ${label}`, hi: `राइडर को फ़ैसला चाहिए: ${label}` }
      : { en: `Rider report: ${label}`, hi: `राइडर रिपोर्ट: ${label}` },
    {
      en: `${who} on order #${id}. Open the board to ${request ? "approve or reject" : "acknowledge"} it.`,
      hi: `ऑर्डर #${id} पर ${who}। ${request ? "मंज़ूर या अस्वीकार" : "स्वीकार"} करने के लिए बोर्ड खोलें।`,
    },
    "/manager",
    request
      ? {
          priority: 10,
          ttlSec: RING_TIMEOUT_SEC.ops,
          data: { ...ringStartData("ops", exceptionId) },
        }
      : {}
  );
}

/** Every ops phone stops ringing for this exception: somebody decided it. Silent. */
export function stopOpsRing(exceptionId: string): Promise<void> {
  return notifyOps({ en: "" }, { en: "" }, "/manager", {
    silent: true,
    data: { ...ringStopData("ops", exceptionId) },
  });
}

/**
 * Ops answered the rider. Rider copy is English only (owner decision for the
 * rider side). What the rider does next depends on the kind, so the message
 * says it: take the food back, confirm the pickup, nothing more to do.
 */
export function notifyDriverExceptionDecided(
  driverId: string,
  opts: {
    orderId: string;
    kind: ExceptionKind;
    status: "approved" | "rejected" | "acknowledged";
    note?: string | null;
  }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  const label = exceptionLabel(opts.kind);
  const note = opts.note?.trim() ? ` Note: ${opts.note.trim()}` : "";
  let heading: string;
  let message: string;
  if (opts.status === "acknowledged") {
    heading = "Ops saw your report";
    message = `${label} on order #${id} is noted.${note}`;
  } else if (opts.status === "rejected") {
    heading = "Request not approved";
    message = `${label} on order #${id} was not approved. Carry on with the job or call ops.${note}`;
  } else {
    heading = "Request approved";
    switch (opts.kind) {
      case "failed_delivery":
      case "customer_unreachable":
      case "wrong_address":
        message = `Order #${id} is closed as failed. Take the food back to the shop.${note}`;
        break;
      case "complete_without_code":
        message = `Order #${id} is marked delivered without the code.${note}`;
        break;
      case "manual_pickup":
        message = `Manual pickup approved for order #${id}. Confirm the pickup in the app.${note}`;
        break;
      case "go_offline":
        message = `Order #${id} has gone back to dispatch and you are offline.${note}`;
        break;
      default:
        message = `${label} on order #${id} was approved.${note}`;
    }
  }
  // An approval that ends the job (failed, or handed back to dispatch) is a
  // cancellation as far as the rider is concerned — never muted. Every other
  // answer is a delivery update.
  const endsJob =
    opts.status === "approved" &&
    ["failed_delivery", "customer_unreachable", "wrong_address", "go_offline"].includes(opts.kind);
  return notifyRider(
    driverId,
    endsJob ? "cancellations" : "delivery_updates",
    { en: heading },
    { en: message },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId, exceptionKind: opts.kind, decision: opts.status } }
  );
}

/* ---------- Phase 7: instructions, reminders, delays, demand, SOS ---------- */

/**
 * The customer changed the delivery instructions while this rider holds the
 * order (Review Focus 3). The new text rides in the data so the app can show
 * it highlighted without a refetch.
 */
export function notifyRiderInstructionsChanged(
  driverId: string,
  opts: { orderId: string; instructions: string | null }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "delivery_updates",
    { en: "Delivery instructions changed" },
    {
      en: opts.instructions
        ? `New instructions for order #${id}: ${opts.instructions}`
        : `The customer removed the instructions for order #${id}.`,
    },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId, instructions: opts.instructions } }
  );
}

/** The order has been ready a while and the rider is not at the shop (sent once). */
export function notifyRiderPickupReminder(
  driverId: string,
  opts: { orderId: string; restaurantName: string; minutes: number }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "pickup_reminders",
    { en: "Order waiting for pickup" },
    { en: `${opts.restaurantName} has had order #${id} ready for ${opts.minutes} min. Please head to the shop.` },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId } }
  );
}

/** The delivery is past its ETA (sent once; ops get `notifyOpsDelayAlert`). */
export function notifyRiderDelayAlert(
  driverId: string,
  opts: { orderId: string; minutesLate: number }
): Promise<void> {
  const id = shortOrderId(opts.orderId);
  return notifyRider(
    driverId,
    "delivery_updates",
    { en: "Running late" },
    { en: `Order #${id} is ${opts.minutesLate} min past its delivery time. If something is wrong, report it in the app.` },
    { url: `/jobs/${opts.orderId}`, data: { orderId: opts.orderId } }
  );
}

export function notifyOpsDelayAlert(
  orderId: string,
  opts: { riderName: string | null; minutesLate: number }
): Promise<void> {
  const id = shortOrderId(orderId);
  return notifyOps(
    { en: "Delivery running late ⏱️" },
    { en: `Order #${id} with ${opts.riderName?.trim() || "a rider"} is ${opts.minutesLate} min past its delivery time.` },
    "/manager"
  );
}

/** Lots of orders, few riders: come online (offline riders seen in the last 14 days). */
export async function notifyRidersHighDemand(driverIds: string[], opts: { waiting: number }): Promise<void> {
  try {
    await notifyUsers(
      driverIds.map((userId) => ({ userId, role: "rider" as const })),
      {
        category: "high_demand",
        title: "High demand near you",
        body: `${opts.waiting} orders are waiting for riders. Go online to pick them up.`,
        url: "/home",
        pushOptions: { url: RIDER_WEB },
      }
    );
  } catch {
    // swallow — fire-and-forget
  }
}

/**
 * A rider pressed SOS (or filed a safety report): push and RING every manager
 * and admin, ring id `ops:sos:<ticketId>` (`ringStartData("ops", "sos:…")`).
 * Everything ops need to act is in the text: who, how to call them, their
 * rider ID, the order they hold and where they are. This alerts Deligro's own
 * staff only — nothing here contacts any outside service.
 *
 * `again`: a later tap on an emergency staff had already acknowledged — the
 * rider is still asking for help, so every phone rings again. Answers whether
 * the push reached anyone (false when push is not configured).
 */
export function notifyOpsSos(
  ticketId: string,
  info: {
    kindLabel: string;
    riderName: string | null;
    riderPhone: string | null;
    riderCode: string | null;
    orderCode: string | null;
    locationUrl: string | null;
    note: string | null;
    again?: boolean;
  }
): Promise<boolean> {
  const who = [info.riderName?.trim() || "A rider", info.riderCode, info.riderPhone].filter(Boolean).join(" · ");
  const parts = [
    `${who} needs help (${info.kindLabel}).`,
    info.orderCode ? `Order ${info.orderCode}.` : "No active order.",
    info.locationUrl ? `Location: ${info.locationUrl}` : "Location not shared.",
    info.note ? `Note: ${info.note}` : "",
  ].filter(Boolean);
  return opsPush(
    { en: info.again ? "🚨 Rider SOS again — still needs help" : "🚨 Rider SOS" },
    { en: parts.join(" ") },
    `/manager/support/${ticketId}`,
    {
      priority: 10,
      ttlSec: RING_TIMEOUT_SEC.ops,
      data: { ...ringStartData("ops", `sos:${ticketId}`), ticketId },
    }
  );
}

/** Somebody picked the emergency up: every ops phone stops ringing for it. Silent. */
export function stopOpsSosRing(ticketId: string): Promise<void> {
  return notifyOps({ en: "" }, { en: "" }, "/manager", {
    silent: true,
    data: { ...ringStopData("ops", `sos:${ticketId}`) },
  });
}
