import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user's identity, used by clients for role-aware routing right
 * after a session is established (and by the separate mobile clients to reject a
 * mismatched role at their own login screen). `role` is null when signed out.
 *
 * `accountStatus` (0151/0162): `active`, `restricted` (can sign in, cannot
 * order) or `suspended`. A database without it, or a failed read, answers
 * `active` — the orders trigger is what actually refuses, this only lets the
 * app say why before the customer fills a basket.
 */
export async function GET() {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ role: null }, { status: 200 });
  }
  let accountStatus = "active";
  try {
    const supabase = await createClient();
    const { data } = await supabase.from("profiles").select("account_status").eq("id", profile.id).maybeSingle();
    const s = (data as { account_status?: string } | null)?.account_status;
    if (s === "restricted" || s === "suspended") accountStatus = s;
  } catch {
    // keep "active"
  }
  return NextResponse.json({ id: profile.id, role: profile.role, accountStatus });
}
