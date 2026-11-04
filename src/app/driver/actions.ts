"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getProfile } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { acceptDelivery, advanceDelivery } from "@/lib/data-access/driver-orders";
import { isRiderSchemaPending, setRiderAvailability } from "@/lib/data-access/rider-status";
import {
  riderPhase,
  type AvailabilityAction,
  type RiderAvailability,
} from "@/lib/rider/availability";
import { captureError } from "@/lib/obs/emit";
import { riderWorkBlock } from "@/lib/data-access/rider-work";
import { maybeSweepDispatch } from "@/lib/dispatch/sweep";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyVendorRiderAssigned, stopRiderRing } from "@/lib/notifications/order-events";
import { addWalletChange } from "@/lib/data-access/wallet";
import { isFeatureOn } from "@/lib/features/flags.server";
import { walletChangeMessage } from "@/lib/wallet/money";

async function requireDriver() {
  const profile = await getProfile();
  if (profile?.role !== "driver") throw new Error("forbidden");
  // 0151: a suspended or rejected rider cannot act (the layout shows them why).
  if (await riderWorkBlock(profile.id)) throw new Error("forbidden");
  return profile;
}

async function requireDriverId(): Promise<string> {
  return (await requireDriver()).id;
}

export async function acceptDeliveryAction(orderId: string) {
  const driver = await requireDriver();
  const driverId = driver.id;

  // A rider genuinely taps Accept a handful of times an hour; the cap is here so
  // a script cannot sweep the ready pool the instant orders appear.
  const limit = await rateLimit(`driver-accept:${driverId}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  const result = await acceptDelivery(driverId, orderId);
  // The kitchen learns who is coming for the bag, instead of finding out on the
  // board's next refresh — or when a stranger walks up to the counter.
  if (result.ok) {
    deferNotify(() => notifyVendorRiderAssigned(orderId, driver.full_name));
    // Accepted: this rider's phones stop ringing for it.
    deferNotify(() => stopRiderRing(driverId, orderId));
  }
  revalidatePath("/driver");
  return result;
}

/**
 * The web board's "No change? Add to wallet". The same database function as the app's
 * route: the rider types what they received and the customer's code, and the server
 * works out the change. Then Delivered is tapped as usual.
 */
export async function addWalletChangeAction(
  orderId: string,
  input: { received: number; code: string; actionId: string }
): Promise<{ ok: true; change: number; received: number } | { ok: false; message: string }> {
  const driver = await requireDriver();
  if (!(await isFeatureOn("driver.cod_change", driver.id))) {
    return { ok: false, message: "This isn't switched on for you. Give the change in cash." };
  }
  const limit = await rateLimit(`rider-wallet-change:${driver.id}`, 20, 60_000);
  if (!limit.ok) return { ok: false, message: "Too many tries. Wait a minute." };
  if (!Number.isInteger(input.received) || input.received <= 0 || input.received > 1_000_000) {
    return { ok: false, message: "Enter the amount received in whole rupees." };
  }
  if (typeof input.code !== "string" || input.code.length > 12) {
    return { ok: false, message: "Enter the customer's code." };
  }
  const result = await addWalletChange(driver.id, orderId, input);
  if (!result.ok) return { ok: false, message: walletChangeMessage(result.error, result) };
  revalidatePath("/driver");
  return { ok: true, change: result.change, received: result.received };
}

export async function advanceDeliveryAction(orderId: string) {
  const driverId = await requireDriverId();

  // The rider app's bucket and limit. `tooManyRequests` is for route handlers;
  // a Server Action answers in the same shape as the rest of this file.
  const limit = await rateLimit(`rider-action:${driverId}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  const result = await advanceDelivery(driverId, orderId);
  revalidatePath("/driver");
  return result;
}

const AVAILABILITY_ACTIONS: readonly AvailabilityAction[] = [
  "online",
  "offline",
  "break",
  "resume",
];

type SetAvailabilityResult =
  | { ok: true; availability: RiderAvailability; phase: ReturnType<typeof riderPhase> }
  | {
      ok: false;
      error:
        | "active_delivery"
        | "invalid_minutes"
        | "not_online"
        | "invalid_action"
        | "rate_limited"
        // Migration 0081 is not applied: there is nowhere to record a shift.
        | "unavailable"
        | "server_error";
    };

/**
 * Go online, go offline, take a break, or come back — the web rider portal's
 * twin of POST /api/rider/status, answering through the same rules
 * (`setRiderAvailability`). The rider id is the session's; nothing here takes
 * one as an argument.
 *
 * `minutes` is for `break` only: 15, 30 or 60, or an explicit `null` for
 * "until I resume". Which numbers are allowed is the rules' call.
 *
 * Failures come back as values, never as a thrown error: this runs inside a
 * click handler, and an uncaught throw from a server action replaces the whole
 * board with the route's error page — a rider mid-shift should get a sentence.
 */
export async function setAvailabilityAction(
  action: AvailabilityAction,
  minutes?: number | null
): Promise<SetAvailabilityResult> {
  const driverId = await requireDriverId();

  // A few taps a shift; 20 a minute absorbs retries and a rider fiddling with
  // break lengths while capping a runaway client.
  const limit = await rateLimit(`driver-availability:${driverId}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  if (!AVAILABILITY_ACTIONS.includes(action)) return { ok: false, error: "invalid_action" };
  if (action === "break" && minutes !== null && typeof minutes !== "number") {
    return { ok: false, error: "invalid_minutes" };
  }

  try {
    const result = await setRiderAvailability(
      driverId,
      action,
      action === "break" ? minutes : undefined
    );
    revalidatePath("/driver");
    if (!result.ok) return result;
    // Back in service: let dispatch look for orders left waiting for a rider.
    // Throttled platform-wide, and after the response.
    if (action === "online" || action === "resume") after(maybeSweepDispatch);
    return {
      ok: true,
      availability: result.next,
      phase: riderPhase(result.next, new Date()),
    };
  } catch (e) {
    captureError(e, {
      source: "driver/actions:setAvailability",
      actorRole: "driver",
      actorId: driverId,
      driverId,
      attrs: { event: "set_availability", action },
    });
    if (isRiderSchemaPending(e)) return { ok: false, error: "unavailable" };
    return { ok: false, error: "server_error" };
  }
}
