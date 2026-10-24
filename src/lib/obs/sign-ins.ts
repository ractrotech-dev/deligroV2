import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentEnv } from "./ids";

/**
 * Sign-in records (OBSERVABILITY_V2.md, phase 3): every OTP and password
 * sign-in, succeeded or failed, tied to the account it was for, with a device
 * label, the country, and whether either is new for that person (0171).
 *
 * Written after the response is sent and never throws: recording a sign-in
 * must never slow or break one. Never given the code, the password or the IP;
 * of the phone number only the last four digits are kept.
 */

export interface SignInAttempt {
  method: "otp" | "password";
  outcome: "success" | "failure";
  /** Our own word: invalid, expired, locked, bad_credentials, suspended… */
  reason?: string | null;
  /** When the route already knows who signed in. */
  actorId?: string | null;
  /** E.164; used to find the account a failure was for, then reduced to 4 digits. */
  phone?: string | null;
}

/** "Chrome on Android", "Safari on iPhone", "Partner app"… from the request's own headers. */
export function deviceLabel(userAgent: string | null, client: string | null): string | null {
  if (client) {
    const app = /deligro-(partner|rider|manager|customer)/i.exec(client)?.[1];
    if (app) return `${app[0].toUpperCase()}${app.slice(1).toLowerCase()} app`;
  }
  const ua = userAgent ?? "";
  if (!ua) return null;
  if (/dart:io|dart\//i.test(ua)) return "Deligro app";
  const os = /android/i.test(ua)
    ? "Android"
    : /iphone|ipad|ipod/i.test(ua)
      ? "iPhone"
      : /windows/i.test(ua)
        ? "Windows"
        : /mac os x|macintosh/i.test(ua)
          ? "Mac"
          : /linux/i.test(ua)
            ? "Linux"
            : "another system";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /samsungbrowser/i.test(ua)
      ? "Samsung Internet"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /safari/i.test(ua)
            ? "Safari"
            : "a browser";
  return `${browser} on ${os}`;
}

async function write(attempt: SignInAttempt, device: string | null, country: string | null): Promise<void> {
  try {
    const supabase = createAdminClient();
    let actor = attempt.actorId ?? null;
    if (!actor && attempt.phone) {
      const { data } = await supabase.from("profiles").select("id").eq("phone", attempt.phone).maybeSingle();
      actor = (data as { id?: string } | null)?.id ?? null;
    }
    const digits = (attempt.phone ?? "").replace(/\D/g, "");
    await supabase.rpc("obs_record_sign_in", {
      p_env: currentEnv(),
      p_method: attempt.method,
      p_outcome: attempt.outcome,
      p_reason: attempt.reason ?? null,
      p_actor: actor,
      p_phone_tail: digits ? digits.slice(-4) : null,
      p_device: device,
      p_country: country,
    });
  } catch {
    /* a sign-in record is never worth a failed sign-in */
  }
}

/** Record one attempt after the response goes out. */
export function recordSignIn(request: Request, attempt: SignInAttempt): void {
  try {
    const device = deviceLabel(request.headers.get("user-agent"), request.headers.get("x-client"));
    const rawCountry = request.headers.get("x-vercel-ip-country");
    const country = rawCountry && /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
    try {
      after(() => write(attempt, device, country));
    } catch {
      // Outside a request scope (a script): write now, detached.
      void write(attempt, device, country);
    }
  } catch {
    /* never throw from telemetry */
  }
}
