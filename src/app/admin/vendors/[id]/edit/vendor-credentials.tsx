"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Section, fieldCls } from "@/components/ui/field";
import { PhoneOtpVerify } from "@/components/admin/phone-otp-verify";
import {
  resetVendorPasswordAction,
  setVendorPasswordAction,
  verifyVendorPhoneAction,
} from "../../actions";

/**
 * Login & credentials block on the Edit screen: what the vendor signs in with,
 * and the mobile they sign in on.
 *
 * The password is stored and re-readable (migration 0039). That is a deliberate
 * reversal of the "shown once, never saved" behaviour this panel used to have —
 * see the migration header for why, and `@/lib/data-access/vendor-credentials`
 * for what contains it. The practical consequence here is that an operator who
 * closes the page has not lost anything, so rotating is a real decision rather
 * than the only way to recover.
 *
 * Hidden until revealed, all the same: a password sitting in plain view on a
 * screen an operator leaves open is a different exposure from one they had to
 * ask for.
 */
export function VendorCredentials({
  id,
  loginEmail,
  loginPassword,
  passwordResetAt,
  ownerMobile,
  ownerPhoneVerified,
}: Readonly<{
  id: string;
  loginEmail: string | null;
  loginPassword: string | null;
  passwordResetAt: string | null;
  ownerMobile: string | null;
  ownerPhoneVerified: boolean;
}>) {
  const router = useRouter();
  // Seeded from the stored value; replaced in place when a new one is issued so
  // the panel doesn't wait on the router refresh to show what it just set.
  const [pw, setPw] = useState<string | null>(loginPassword);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(ownerPhoneVerified);
  const [pending, start] = useTransition();

  const regenerate = () => {
    if (
      pw &&
      !window.confirm(
        "Generate a new password? The current one stops working straight away."
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const res = await resetVendorPasswordAction(id);
      if (!res.ok || !res.tempPassword) {
        setError(res.error ?? "Couldn't generate a password.");
        return;
      }
      setCopied(false);
      setShown(true);
      setPw(res.tempPassword);
      router.refresh();
    });
  };

  const setChosen = () => {
    setError(null);
    start(async () => {
      const res = await setVendorPasswordAction(id, draft);
      if (!res.ok) {
        setError(res.error ?? "Couldn't set that password.");
        return;
      }
      setPw(draft.trim());
      setDraft("");
      setShown(true);
      setCopied(false);
      router.refresh();
    });
  };

  const copy = async () => {
    if (!pw) return;
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
    } catch {
      /* clipboard blocked — the value is visible to read/type */
    }
  };

  const chip =
    "press grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted transition-colors hover:text-ink disabled:opacity-50";
  const GenerateIcon = pw ? RefreshCw : KeyRound;

  return (
    <Section title="Login & credentials">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-muted">Signs in with</span>
        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-xs text-muted">
          <SignInSummary ownerMobile={ownerMobile} loginEmail={loginEmail} />
        </p>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-muted">Password</span>
        {pw ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-2.5">
            <code className="text-data flex-1 break-all px-1 text-[15px] font-semibold text-ink">
              {shown ? pw : "••••••••••••"}
            </code>
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              className={chip}
              aria-label={shown ? "Hide password" : "Show password"}
            >
              {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              type="button"
              onClick={copy}
              className={chip}
              aria-label="Copy password"
            >
              {copied ? (
                <Check className="size-4 text-green" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </div>
        ) : (
          <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-xs text-muted">
            {noPasswordNote(passwordResetAt)}
          </p>
        )}

        <button
          type="button"
          onClick={regenerate}
          disabled={pending}
          className="press inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GenerateIcon className="size-3.5" />
          )}
          {pw ? "Generate new password" : "Generate password"}
        </button>

        <div className="flex items-center gap-2 pt-1.5">
          {/* Not inside a <form>: this panel renders beside the vendor edit
              form, and a nested form is invalid HTML. Enter is wired by hand. */}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.trim().length >= 8) setChosen();
              }
            }}
            placeholder="Or type a password (8+ characters)"
            spellCheck={false}
            autoComplete="off"
            aria-label="Set a specific password"
            className={`${fieldCls} min-w-0 flex-1 py-2 text-[13px]`}
          />
          <button
            type="button"
            onClick={setChosen}
            disabled={pending || draft.trim().length < 8}
            className="press shrink-0 rounded-full bg-ink px-3.5 py-2 text-xs font-bold text-[color:var(--surface)] disabled:opacity-40"
          >
            Set
          </button>
        </div>

        <p className="text-[11px] text-muted">
          Either action replaces the vendor&apos;s current login immediately. The
          value is saved against the shop so you can read it back to them.
        </p>
        {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
      </div>

      <div className="space-y-1.5 border-t border-line pt-3">
        <span className="text-xs font-semibold text-muted">Mobile verification</span>
        {ownerMobile ? (
          <PhoneOtpVerify
            phone={ownerMobile}
            verified={verified}
            onVerified={() => {
              setVerified(true);
              router.refresh();
            }}
            verify={(phone, code) => verifyVendorPhoneAction(id, phone, code)}
          />
        ) : (
          <p className="text-xs text-muted">Add a mobile number to enable OTP verification.</p>
        )}
      </div>
    </Section>
  );
}

/** Which identifiers the vendor can sign in with, given what is on file. */
function SignInSummary({
  ownerMobile,
  loginEmail,
}: Readonly<{ ownerMobile: string | null; loginEmail: string | null }>) {
  if (ownerMobile) {
    return (
      <>
        Mobile <b className="text-data text-ink">{ownerMobile}</b> (or the
        email <b className="text-ink">{loginEmail ?? "— not set —"}</b>)
        and the password below.
      </>
    );
  }
  return (
    <>
      Email <b className="text-ink">{loginEmail ?? "— not set —"}</b> and
      the password below. Add a mobile number to enable number sign-in.
    </>
  );
}

/** Why there is no password to show: never issued, or issued before it was saved. */
function noPasswordNote(passwordResetAt: string | null): string {
  return passwordResetAt
    ? `A password was issued ${new Date(passwordResetAt).toLocaleDateString()}, before passwords were saved here. Generate a new one to have a copy you can read back.`
    : "No password issued yet. Generate one, or set one the owner will remember.";
}
