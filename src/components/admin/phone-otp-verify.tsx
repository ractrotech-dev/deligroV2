"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, Loader2, ShieldCheck } from "lucide-react";
import { fieldCls } from "@/components/ui/field";

/**
 * Inline mobile-OTP verification for operators. Requests a code to the vendor's
 * phone via the public /api/auth/otp/request endpoint, then hands the entered
 * code to a caller-supplied `verify` — the wizard verifies against the admin
 * verify-phone route (no session minted), the Edit screen against a server
 * action that also persists. Non-blocking: it's an affordance, not a gate.
 */
export function PhoneOtpVerify({
  phone,
  verified,
  disabled,
  onVerified,
  verify,
}: Readonly<{
  phone: string;
  verified: boolean;
  disabled?: boolean;
  onVerified: () => void;
  verify: (phone: string, code: string) => Promise<{ ok: boolean; error?: string }>;
}>) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (verified) {
    return (
      <p className="flex items-center gap-1.5 text-xs font-semibold text-green">
        <BadgeCheck className="size-4" /> Mobile verified
      </p>
    );
  }

  async function requestCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "cooldown") setCooldown(data.retryAfter ?? 30);
        setError(errorText(data.error));
        return;
      }
      setDevCode(data.devCode ?? null);
      setSent(true);
      setOpen(true);
      setCooldown(30);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await verify(phone, code);
      if (!res.ok) {
        setError(errorText(res.error));
        return;
      }
      setOpen(false);
      setCode("");
      onVerified();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  const canSend = Boolean(phone) && !disabled && !busy && cooldown === 0;

  return (
    <div className="space-y-2">
      {!open ? (
        <button
          type="button"
          onClick={requestCode}
          disabled={!canSend}
          className="press inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {sendLabel(cooldown, sent)}
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
          <p className="text-xs text-muted">
            Enter the 6-digit code sent to <span className="font-semibold text-ink">{phone}</span>.
          </p>
          {devCode ? (
            <p className="text-[11px] text-muted">
              Dev mode — code is <span className="text-data font-bold text-ink">{devCode}</span>
            </p>
          ) : null}
          <input
            className={fieldCls}
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="••••••"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submitCode}
              disabled={busy || code.length !== 6}
              className="press inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-[var(--on-accent)] disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Verify"}
            </button>
            <button
              type="button"
              onClick={requestCode}
              disabled={cooldown > 0 || busy}
              className="press text-xs font-semibold text-accent disabled:text-muted"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend"}
            </button>
          </div>
        </div>
      )}
      {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
    </div>
  );
}

/** The send button's label: counting down, a resend, or the first send. */
function sendLabel(cooldown: number, sent: boolean): string {
  if (cooldown > 0) return `Resend in ${cooldown}s`;
  return sent ? "Resend code" : "Send OTP to verify";
}

function errorText(code?: string): string {
  switch (code) {
    case "invalid_phone":
    case "invalid_input":
      return "Enter a valid mobile number.";
    case "invalid":
      return "That code isn't right. Try again.";
    case "expired":
    case "no_code":
      return "Code expired — request a new one.";
    case "locked":
      return "Too many tries. Request a new code.";
    case "cooldown":
      return "Please wait before resending.";
    case "too_many":
    case "rate_limited":
      return "Too many requests. Try again later.";
    case "daily_limit":
      return "This number has reached today's OTP limit. Try again tomorrow.";
    case "sms_unavailable":
      return "SMS isn't available right now.";
    case "phone_taken":
      return "That number is already registered to another account.";
    default:
      return "Something went wrong. Try again.";
  }
}
