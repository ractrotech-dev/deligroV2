import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isIndianMobile, toE164 } from "@/lib/auth/phone";
import { createOtp } from "@/lib/data-access/otp";
import { sendOtpSms } from "@/lib/sms/renflair";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

/** POST /api/auth/otp/request  { phone } → sends a code via Renflair. */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  try {
    // createOtp caps 6/hour per NUMBER, which does nothing about one client
    // walking a list of numbers — each send costs real money at the SMS gateway,
    // so cap the caller too (classic SMS-pumping / toll-fraud shape).
    const ipLimit = await rateLimit(
      `otp-request-ip:${clientIp(request)}`,
      15,
      60 * 60_000
    );
    if (!ipLimit.ok) return tooManyRequests(ipLimit);

    let body: { phone?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const phone = toE164(body.phone ?? "");
    if (!phone || !isIndianMobile(phone)) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }

    const result = await createOtp(phone);
    if (!result.ok) {
      const status =
        result.error === "cooldown" ||
        result.error === "too_many" ||
        result.error === "daily_limit"
          ? 429
          : result.error === "db_error"
            ? 500
            : 400;
      return NextResponse.json(
        { error: result.error, retryAfter: result.retryAfter },
        { status }
      );
    }

    const sms = await sendOtpSms(phone, result.code!);

    // Handing the code back in the response makes the flow testable without an SMS
    // provider — and would hand anyone the login code for any phone number, which
    // is a complete pre-auth account takeover. `devMode` alone is not enough of a
    // guard: it is true whenever RENFLAIR_API_KEY is missing, and a key missing
    // from the production environment is exactly the accident that must not become
    // an authentication bypass. So it is also fenced behind a non-production build.
    const inProduction = process.env.NODE_ENV === "production";
    const devCode = sms.devMode && !inProduction ? result.code : undefined;

    // A production deploy with no SMS provider can't sign anyone in. Say so,
    // rather than silently returning ok:true for a code that was never delivered.
    if (sms.devMode && inProduction) {
      console.error(
        "OTP requested but RENFLAIR_API_KEY is not set — no SMS was sent."
      );
      return NextResponse.json({ error: "sms_unavailable" }, { status: 503 });
    }

    return NextResponse.json({
      ok: true,
      sent: sms.sent,
      devMode: sms.devMode,
      devCode,
      remainingToday: result.remainingToday,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[otp/request]", message);
    if (message.includes("OTP_PEPPER")) {
      return NextResponse.json({ error: "otp_misconfigured" }, { status: 503 });
    }
    if (message.includes("SUPABASE_SERVICE_ROLE") || message.includes("SERVICE_ROLE")) {
      return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
