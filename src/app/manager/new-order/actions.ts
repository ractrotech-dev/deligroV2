"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  getShopMenu,
  lookupCaller,
  placePhoneOrder,
  phoneOrderErrorCode,
  type CallerLookup,
  type PhoneOrderError,
  type PhoneOrderInput,
  type ShopMenu,
} from "@/lib/data-access/manager-phone-orders";

/**
 * The phone-order desk's three server actions.
 *
 * AGENTS.md #3: a Server Action is a public HTTP endpoint, so every export here
 * opens with `requireRole`. `["manager", "admin"]` matches the /manager layout,
 * which admits both — gating on "manager" alone would render the screen for an
 * admin and then bounce every button they pressed.
 *
 * All three are rate-limited on the operator's own id. That is not boilerplate
 * on this path: `placeOrder` creates auth accounts and orders in other people's
 * names, and `lookup` answers "does this number have an account?", which run in
 * a loop is a subscriber-enumeration oracle. A manager can already read
 * `profiles` (0023) so neither is new exposure — but a stolen manager session
 * should cost an attacker time.
 */

const DEMO = "Demo mode: connect Supabase and apply 0029 to take phone orders.";

export interface LookupResult {
  ok: boolean;
  caller?: CallerLookup;
  error?: string;
}

export interface MenuResult {
  ok: boolean;
  menu?: ShopMenu;
  error?: string;
}

export interface PlaceResult {
  ok: boolean;
  /** `#ABC12345` — read back to the caller before hanging up. */
  code?: string;
  total?: number;
  customerCreated?: boolean;
  error?: string;
}

/** Who owns the number the operator just typed, if anyone. */
export async function lookupCallerAction(phone: string): Promise<LookupResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.phone_orders"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const limit = await rateLimit(`phone-order-lookup:${profile.id}`, 120, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many lookups. Wait a moment." };

  try {
    const caller = await lookupCaller(phone);
    if (!caller) return { ok: false, error: "That isn't a usable mobile number." };
    return { ok: true, caller };
  } catch {
    return { ok: false, error: "Could not check that number. Try again." };
  }
}

/** One shop's orderable dishes, fetched when the operator picks it. */
export async function loadShopMenuAction(slug: string): Promise<MenuResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.phone_orders"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const limit = await rateLimit(`phone-order-menu:${profile.id}`, 120, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  try {
    const menu = await getShopMenu(slug);
    if (!menu) return { ok: false, error: "That restaurant isn't available." };
    return { ok: true, menu };
  } catch {
    return { ok: false, error: "Could not load that menu. Try again." };
  }
}

/**
 * What the operator sees for each way this can fail. Every message names the
 * thing to change, because it is read aloud-adjacent: someone is on the line
 * while it is on screen.
 */
const MESSAGES: Record<PhoneOrderError, string> = {
  not_migrated:
    "This database can't record who took a phone order (migration 0029). Orders are refused rather than logged anonymously.",
  invalid_phone: "That isn't a usable mobile number.",
  restaurant_not_found: "That restaurant isn't available.",
  restaurant_closed: "That kitchen is closed right now — it can't take the order.",
  empty_cart: "Add at least one dish.",
  invalid_items:
    "A dish is no longer on the menu or has sold out. Reload the menu and check with the caller.",
  too_many_items: "That's too many separate dishes for one order.",
  account_failed: "Could not set up an account for that number. Try again.",
  cod_not_accepted:
    "That shop does not take cash on delivery. A phone order can only be paid in cash, so it has to be placed in the app.",
  cod_over_limit:
    "This order is over that shop's cash limit. Remove some items, or ask the caller to order in the app and pay online.",
  instructions_too_long: "That note is too long — keep it under 300 characters.",
  order_not_created: "The order didn't save. Nothing was charged — try again.",
};

/** Place the order. The money is computed server-side; this input carries none. */
export async function placePhoneOrderAction(
  input: PhoneOrderInput
): Promise<PlaceResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.phone_orders"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  // Tighter than the customer checkout's 20/min: a human on a phone call places
  // one order every few minutes, so anything near this ceiling is not a person
  // taking calls.
  const limit = await rateLimit(`phone-order-place:${profile.id}`, 12, 60_000);
  if (!limit.ok) {
    return { ok: false, error: "Too many orders too fast. Wait a moment." };
  }

  try {
    const result = await placePhoneOrder(profile, input);
    // The new order belongs on the live board the operator returns to.
    revalidatePath("/manager");
    return {
      ok: true,
      code: result.code,
      total: result.charges.total,
      customerCreated: result.customerCreated,
    };
  } catch (err) {
    const code = phoneOrderErrorCode(err);
    if (code) return { ok: false, error: MESSAGES[code] };
    return { ok: false, error: "That didn't go through. Nothing was saved." };
  }
}
