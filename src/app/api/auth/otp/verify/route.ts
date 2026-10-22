import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { toE164 } from "@/lib/auth/phone";
import { verifyOtp } from "@/lib/data-access/otp";
import { customerLoginRefusal } from "@/lib/auth/account-status.server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * POST /api/auth/otp/verify  { phone, code }
 * → { tokenHash, email } which the client exchanges via
 *   supabase.auth.verifyOtp({ token_hash, type: "email" }) to set its session.
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  try {
    // The per-row MAX_ATTEMPTS lock is per code: request a fresh code and the
    // counter resets, so a patient attacker still gets unlimited guesses at a
    // 6-digit space. Cap the caller so the whole flow is bounded, not each code.
    const ipLimit = await rateLimit(
      `otp-verify-ip:${clientIp(request)}`,
      20,
      60 * 60_000
    );
    if (!ipLimit.ok) return tooManyRequests(ipLimit);

    let body: { phone?: string; code?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const phone = toE164(body.phone ?? "");
    const code = (body.code ?? "").replace(/\D/g, "");
    if (!phone || code.length !== 6) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    const result = await verifyOtp(phone, code);
    if (!result.ok) {
      const status =
        result.error === "invalid" ||
        result.error === "expired" ||
        result.error === "locked"
          ? 401
          : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    // A suspended customer (0162) gets no token, so no session. Checked after
    // the code is proven, so the answer never tells a stranger about an account.
    if ((await customerLoginRefusal({ phone })) === "account_suspended") {
      return NextResponse.json({ error: "account_suspended" }, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      tokenHash: result.tokenHash,
      email: result.email,
      isNewUser: result.isNewUser,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[otp/verify]", message);
    if (message.includes("OTP_PEPPER")) {
      return NextResponse.json({ error: "otp_misconfigured" }, { status: 503 });
    }
    if (message.includes("SUPABASE_SERVICE_ROLE") || message.includes("SERVICE_ROLE")) {
      return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
