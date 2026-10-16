/**
 * How many OTPs one number may ask for, and when it may ask again.
 *
 * Pure — no Supabase, no clock of its own — so `createOtp` feeds it the send
 * times it read from `otp_codes`, and `scripts/qa/otp-limits.ts` feeds it made-up
 * ones. Every send is a paid SMS, so these caps are a cost control as much as an
 * abuse control.
 *
 * Every refusal carries the exact number of seconds until the next send would
 * be allowed. The login screen turns that into "try again after 4:30 PM"; a flat
 * "try later" is what had people pressing Resend over and over.
 */

export const OTP_LIMITS = {
  /** Minimum gap between two sends to the same number. */
  cooldownMs: 30 * 1000,
  /** Sends per number in any rolling hour. */
  perHour: 6,
  /** Sends per number per IST calendar day — resets at midnight in India. */
  perDay: 10,
} as const;

type OtpLimitError = "cooldown" | "too_many" | "daily_limit";

export type OtpLimitVerdict =
  | { ok: true; /** Sends left today *after* this one. */ remainingToday: number }
  | { ok: false; error: OtpLimitError; /** Seconds until a send is allowed. */ retryAfter: number };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// India has no daylight saving, so a fixed offset is exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** 00:00 IST of the day `now` falls in, as epoch ms. */
export function istDayStart(now: number): number {
  return Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** The next 00:00 IST after `now`, as epoch ms — when the daily cap resets. */
export function nextIstMidnight(now: number): number {
  return istDayStart(now) + DAY_MS;
}

/**
 * The earliest send time `createOtp` needs to read to judge a request at `now`:
 * whichever reaches further back, the rolling hour or the start of today.
 */
export function otpLookbackStart(now: number): number {
  return Math.min(now - HOUR_MS, istDayStart(now));
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Judge one more send to a number, given when the previous ones went out.
 * `sentAt` is epoch ms, in any order; entries older than the lookback are
 * ignored.
 *
 * The daily cap is checked first: once it is hit, the cooldown and hourly
 * waits are irrelevant, and "come back tomorrow" is the only useful answer.
 */
export function checkOtpLimits(sentAt: readonly number[], now: number): OtpLimitVerdict {
  const dayStart = istDayStart(now);
  const today = sentAt.filter((t) => t >= dayStart && t <= now);

  if (today.length >= OTP_LIMITS.perDay) {
    return { ok: false, error: "daily_limit", retryAfter: seconds(nextIstMidnight(now) - now) };
  }

  const lastHour = sentAt.filter((t) => t > now - HOUR_MS && t <= now).sort((a, b) => a - b);

  const last = lastHour.at(-1);
  if (last !== undefined && now - last < OTP_LIMITS.cooldownMs) {
    return { ok: false, error: "cooldown", retryAfter: seconds(OTP_LIMITS.cooldownMs - (now - last)) };
  }

  if (lastHour.length >= OTP_LIMITS.perHour) {
    // Allowed again once enough of the oldest sends age out of the hour to
    // leave room for one more — not a flat hour from now.
    const freeing = lastHour[lastHour.length - OTP_LIMITS.perHour];
    return { ok: false, error: "too_many", retryAfter: seconds(freeing + HOUR_MS - now) };
  }

  return { ok: true, remainingToday: OTP_LIMITS.perDay - today.length - 1 };
}
