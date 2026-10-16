"use server";

import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { acceptDelivery, advanceDelivery } from "@/lib/data-access/driver-orders";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyVendorRiderAssigned, stopRiderRing } from "@/lib/notifications/order-events";

async function requireDriver() {
  const profile = await getProfile();
  if (profile?.role !== "driver") throw new Error("forbidden");
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

export async function advanceDeliveryAction(orderId: string, otp?: string) {
  const driverId = await requireDriverId();

  // This is the delivery-OTP gate, and it is guessable: the code is four digits,
  // so 10 000 combinations. The rider who would want to guess it is the one who
  // already has the food and would rather not meet the customer — an assigned
  // rider, passing every other check. Ten attempts a minute turns an exhaustive
  // search into something that takes most of a day and shows up as a pattern
  // long before it succeeds. `tooManyRequests` is for route handlers; a Server
  // Action answers in the same shape as the rest of this file.
  const limit = await rateLimit(`driver-advance:${driverId}`, 10, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  const result = await advanceDelivery(driverId, orderId, otp);
  revalidatePath("/driver");
  return result;
}
