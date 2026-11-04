"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Panel } from "@/components/admin/console";
import { PhoneOtpVerify } from "@/components/admin/phone-otp-verify";
import { verifyVendorPhoneAction } from "../actions";
import { VendorPasswordDialog } from "../vendor-password-dialog";

/**
 * Login & credentials block on the shop's Access tab, the one place it lives:
 * what the vendor signs in with, and the mobile they sign in on.
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
  name,
  loginEmail,
  loginMobile,
  loginPassword,
  passwordResetAt,
  ownerMobile,
  ownerPhoneVerified,
}: Readonly<{
  id: string;
  name: string;
  /** The auth user's own email, not the shop row's contact email. */
  loginEmail: string | null;
  /** The phone on the owner's profile, which is what mobile sign-in looks up. */
  loginMobile: string | null;
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
  const [resetting, setResetting] = useState(false);
  const [verified, setVerified] = useState(ownerPhoneVerified);

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
    "grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-ink";

  return (
    <Panel title="Login & credentials">
      <div className="grid grid-cols-3 gap-8">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-muted">Signs in with</p>
          <dl className="mt-1.5 space-y-1 text-[13px]">
            <div className="flex items-baseline gap-2">
              <dt className="w-[52px] shrink-0 text-[12px] text-muted">Mobile</dt>
              <dd className="text-data min-w-0 truncate font-semibold text-ink">{loginMobile ?? "Not set"}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-[52px] shrink-0 text-[12px] text-muted">Email</dt>
              <dd className="min-w-0 truncate font-semibold text-ink" title={loginEmail ?? undefined}>
                {loginEmail ?? "Not set"}
              </dd>
            </div>
          </dl>
          <p className="mt-1.5 text-[11.5px] text-muted">
            {loginMobile
              ? "Either one, with the password."
              : "Email and password. Verify a mobile number to enable number sign-in."}
          </p>
        </div>

        <div className="min-w-0">
          <p className="text-[12px] font-medium text-muted">Password</p>
          {pw ? (
            <div className="mt-1.5 flex h-9 items-center gap-1 rounded-[var(--c-r)] bg-surface-2 pl-3 pr-1">
              <code className="text-data min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
                {shown ? pw : "••••••••••••"}
              </code>
              <button
                type="button"
                onClick={() => {
                  setShown((s) => !s);
                  setCopied(false);
                }}
                className={chip}
                aria-label={shown ? "Hide password" : "Show password"}
              >
                {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              {shown ? (
                <button type="button" onClick={copy} className={chip} aria-label="Copy password">
                  {copied ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mt-1.5 rounded-[var(--c-r)] bg-surface-2 px-3 py-2 text-[12px] text-muted">
              {noPasswordNote(passwordResetAt)}
            </p>
          )}
          <button type="button" onClick={() => setResetting(true)} className="c-btn c-btn-outline mt-2">
            Reset password
          </button>
          <VendorPasswordDialog
            id={id}
            name={name}
            open={resetting}
            onClose={() => setResetting(false)}
            onDone={(next) => {
              setPw(next);
              setShown(true);
              setCopied(false);
              router.refresh();
            }}
          />
        </div>

        <div className="min-w-0">
          <p className="text-[12px] font-medium text-muted">Mobile verification</p>
          <p className="mb-2 mt-1.5 text-[11.5px] leading-relaxed text-muted">
            Checks the shop&apos;s contact mobile. Once verified, it becomes the number they sign in with.
          </p>
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
            <p className="text-[12px] text-muted">Add a mobile number to enable OTP verification.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Why there is no password to show: never issued, or issued before it was saved. */
function noPasswordNote(passwordResetAt: string | null): string {
  return passwordResetAt
    ? `A password was issued ${new Date(passwordResetAt).toLocaleDateString()}, before passwords were saved here. Reset it to have a copy you can read back.`
    : "No password issued yet. Reset password makes one.";
}
