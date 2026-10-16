"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/providers/lang-provider";
import type { T } from "@/lib/i18n/lang";

/** Why the server wouldn't text a code to the new number. */
function codeRequestError(t: T, error?: string): string {
  switch (error) {
    case "invalid_phone":
      return t("Enter a valid phone number.", "सही फ़ोन नंबर डालें।");
    case "daily_limit":
      return t(
        "This number has reached today's OTP limit. Try again tomorrow.",
        "इस नंबर पर आज के ओटीपी की सीमा पूरी हो गई। कल फिर कोशिश करें।",
      );
    case "cooldown":
    case "too_many":
    case "rate_limited":
      return t(
        "Too many codes requested. Wait a moment and try again.",
        "बहुत बार कोड मांगा गया। थोड़ा रुककर फिर कोशिश करें।",
      );
    default:
      return t(
        "Couldn't send a code. Try again.",
        "कोड नहीं भेज पाए। फिर कोशिश करें।",
      );
  }
}

/** Why the profile change was refused. */
function saveError(t: T, error?: string): string {
  switch (error) {
    case "invalid_phone":
      return t("Enter a valid phone number.", "सही फ़ोन नंबर डालें।");
    case "otp_invalid":
      return t(
        "That code isn't right. Check it and try again.",
        "यह कोड सही नहीं है। जांचकर फिर कोशिश करें।",
      );
    case "phone_taken":
      return t(
        "This number is already linked to another account. Sign in to that account, or use a different number.",
        "यह नंबर पहले से किसी दूसरे खाते से जुड़ा है। उस खाते से लॉग इन करें, या दूसरा नंबर डालें।",
      );
    default:
      return t(
        "Could not save. Try again.",
        "सेव नहीं हो पाया। फिर कोशिश करें।",
      );
  }
}

export function ProfileEditSheet({
  open,
  field,
  value,
  onClose,
}: Readonly<{
  open: boolean;
  field: "name" | "phone";
  value: string;
  onClose: () => void;
}>) {
  const router = useRouter();
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A phone change is an identity claim, not a preference: profiles.phone is
  // what OTP login resolves an account from, so the server demands a code sent
  // to the NEW number. Step 2 appears only once the server asks for it.
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");

  // The draft starts from the saved value each time the sheet opens (and if the
  // saved value changes underneath it). Adjusted during render rather than in
  // an effect: an effect would paint one frame holding the previous edit before
  // correcting itself, and React re-runs this render before touching the DOM.
  const [synced, setSynced] = useState({ open, value });
  if (synced.open !== open || synced.value !== value) {
    setSynced({ open, value });
    if (open) {
      setDraft(value);
      setError(null);
      setOtpSent(false);
      setOtp("");
    }
  }

  if (!open) return null;

  const title =
    field === "name"
      ? t("Edit name", "नाम बदलें")
      : t("Edit phone", "फ़ोन नंबर बदलें");
  const placeholder =
    field === "name" ? t("Your full name", "आपका पूरा नाम") : "+91 98765 43210";
  const saveLabel = otpSent
    ? t("Verify & save", "जांचें और सेव करें")
    : t("Save", "सेव करें");

  /** Ask the server to text a code to the number being claimed. */
  async function requestCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(codeRequestError(t, data.error));
        return;
      }
      setOtpSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          field === "name"
            ? { fullName: draft }
            : { phone: draft, phoneOtp: otp || undefined },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // otp_required is the expected first answer for a genuine change —
        // it's the server telling us to run the verification step, not a
        // failure to show as one.
        if (data.error === "otp_required") {
          await requestCode();
          return;
        }
        setError(saveError(t, data.error));
        return;
      }
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t("Close", "बंद करें")}
        onClick={onClose}
        className="absolute inset-0 bg-ink/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-heading">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <input
          type={field === "phone" ? "tel" : "text"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Editing the number invalidates a code sent to the old one.
            if (otpSent) {
              setOtpSent(false);
              setOtp("");
            }
          }}
          placeholder={placeholder}
          disabled={otpSent}
          className="w-full rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />

        {otpSent ? (
          <div className="mt-3 space-y-1.5">
            <label
              htmlFor="phone-otp"
              className="text-xs font-semibold text-muted"
            >
              {t(
                `Enter the 6-digit code sent to ${draft}`,
                `${draft} पर भेजा गया 6 अंकों का कोड डालें`,
              )}
            </label>
            <input
              id="phone-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className="text-data w-full rounded-xl bg-surface-2 px-3.5 py-3 text-[17px] tracking-[0.3em] outline-none focus:ring-2 focus:ring-accent/30"
            />
            <button
              type="button"
              onClick={requestCode}
              disabled={busy}
              className="press text-xs font-bold text-accent disabled:opacity-50"
            >
              {t("Resend code", "कोड फिर से भेजें")}
            </button>
          </div>
        ) : null}

        {error ? <p className="mt-2 text-sm text-deal">{error}</p> : null}
        <Button
          className="mt-4 w-full"
          disabled={busy || (otpSent && otp.length !== 6)}
          onClick={save}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : saveLabel}
        </Button>
      </div>
    </div>
  );
}
