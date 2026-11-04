"use server";

import { revalidatePath } from "next/cache";
import { statusReason } from "@/lib/vendors/status-reason";
import { requireRole } from "@/lib/auth";
import { approveRestaurant } from "@/lib/data-access/admin-stats";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Non-blocking: the action succeeded, but there's something to know about it. */
  warning?: string;
  /** The machine-readable outcome, where the screen acts on it. */
  code?: string;
}

/**
 * Real admin decisions. These exist because the buttons that used to sit on
 * these screens called nothing at all.
 *
 * `requireRole` gates the call, and RLS gates the write, so neither one alone is
 * load-bearing.
 */
export async function approveRestaurantAction(id: string, reason: string): Promise<ActionResult> {
  await requireRole("admin");
  const why = statusReason(reason);
  if (!why) return { ok: false, error: "Give a reason (at least 3 characters)." };

  try {
    await approveRestaurant(id, why);
  } catch (err) {
    // The map-pin check explains itself; anything else is a retry.
    const message = err instanceof Error && /pin/i.test(err.message) ? err.message : "Couldn't approve. Try again.";
    return { ok: false, error: message };
  }

  // The storefront is now live — the customer feed must be rebuilt.
  revalidatePath("/", "layout");
  return { ok: true };
}
