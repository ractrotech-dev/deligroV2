"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Mail, ShieldAlert, Smartphone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { OtpLogin } from "@/components/auth/otp-login";
import { signInWithMobileAction } from "@/app/(portal-auth)/actions";
import { PORTALS, type PortalKey } from "@/lib/auth/portals";
import type { Surface } from "@/lib/auth/surfaces";

/**
 * The sign-in form behind every operator door (/admin/login, /vendor/login, …).
 *
 * One form, one portal: it never asks who you are and routes accordingly — it
 * signs you in and sends you to *this* portal. If the account can't open this
 * door, the portal layout's `requireRole()` bounces straight back here with
 * `denied=1`, which is why the wrong-account banner below matters: without it a
 * signed-in customer would ping-pong between the two.
 *
 * The first field takes an email address *or* a mobile number, decided by
 * whether it contains an `@`. Vendors are onboarded by hand and are given their
 * number and a password — most of them never learn the email address the
 * account was created against — so an email-only door locks out the people it
 * exists for. The mobile path runs through a Server Action
 * (`signInWithMobileAction`) rather than the browser client, because resolving
 * a number to its account's email has to stay behind the password check.
 */
export function OperatorLogin({
  portalKey,
  landing,
  denied = false,
  signedInAs = null,
  elsewhere = [],
}: Readonly<{
  portalKey: PortalKey;
  /** Pre-resolved destination (portal home, or a deep link inside it). */
  landing: string;
  /** A role check just failed for the account that is signed in. */
  denied?: boolean;
  /** Set when someone is signed in but can't enter here. */
  signedInAs?: string | null;
  /**
   * The doors the signed-in account *can* open — everything but this one.
   * Presentation only; each one still guards itself server-side.
   */
  elsewhere?: readonly Surface[];
}>) {
  const portal = PORTALS[portalKey];
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "otp">("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** An `@` is the only thing that separates the two; nothing else is ambiguous. */
  const looksLikeEmail = identifier.includes("@");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isSupabaseConfigured) {
      setError(
        "Auth isn't configured yet. Add your Supabase keys to .env.local, then run the migrations."
      );
      return;
    }

    setBusy(true);

    if (looksLikeEmail) {
      const supabase = createClient();
      const { error: sErr } = await supabase.auth.signInWithPassword({
        email: identifier.trim(),
        password,
      });
      setBusy(false);
      if (sErr) {
        // Deliberately generic — don't reveal whether the email exists.
        setError("Incorrect email or password.");
        return;
      }
    } else {
      const res = await signInWithMobileAction(identifier, password);
      setBusy(false);
      if (!res.ok) {
        setError(res.error ?? "Incorrect mobile number or password.");
        return;
      }
    }

    // Straight to the portal. Whether this account may actually be here is the
    // layout's call, server-side; a wrong role lands back on this page with
    // `denied=1` rather than being decided in the browser.
    router.push(landing);
    router.refresh();
  }

  const header = (
    <div className="text-center">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
        Deligro
      </p>
      <h1 className="mt-1.5 text-[26px] font-extrabold tracking-tight">
        {portal.label}
      </h1>
      <p className="mt-1.5 text-sm text-muted">{portal.blurb}</p>
    </div>
  );

  const deniedNotice = denied ? (
    <p className="mt-5 flex items-start gap-2 rounded-xl bg-deal-soft px-3 py-2.5 text-sm font-medium text-deal">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      That account doesn&apos;t have access to {portal.label}.
    </p>
  ) : null;

  /**
   * The wrong-account block: what happened, where that account *does* work, and
   * one press to become somebody else.
   *
   * It used to be a sentence — "…doesn't have access. Sign in with an account
   * that does." — with the only way to act on it a grey text link below the
   * form. That reads as a dead end to anyone testing with the seeded
   * single-role accounts (Demo Vendor holds the restaurant portal and nothing
   * else, Demo Driver the driver one), because moving between doors in one
   * browser means every other door correctly refuses the session already there.
   * The refusal is right; leaving someone with no next step is not.
   *
   * Contains its own <form> (sign-out), so this whole block renders as a
   * SIBLING of the sign-in form, never inside it — nested forms are invalid
   * HTML and throw a hydration error.
   */
  const notices = signedInAs ? (
    <div className="mt-5 rounded-2xl border border-line bg-surface-2 p-3.5">
      <p className="flex items-start gap-2 text-sm font-medium text-ink">
        {denied ? (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-deal" />
        ) : null}
        <span>
          Signed in as{" "}
          <span className="font-bold">{signedInAs}</span> — that account
          can&apos;t open {portal.label}.
        </span>
      </p>

      {elsewhere.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-bold uppercase tracking-[0.06em] text-muted">
            It can open
          </p>
          <div className="mt-1.5 space-y-1">
            {elsewhere.map((surface) => (
              <Link
                key={surface.key}
                href={surface.href}
                className="press flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm font-semibold text-ink"
              >
                {surface.label}
                <ArrowRight className="size-4 shrink-0 text-muted" />
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <form
        action={`/auth/signout?next=${encodeURIComponent(portal.login)}`}
        method="post"
        className="mt-3"
      >
        <button
          type="submit"
          className="press flex h-11 w-full items-center justify-center rounded-full border border-line bg-surface text-sm font-bold text-ink"
        >
          Sign out &amp; use another account
        </button>
      </form>
    </div>
  ) : (
    deniedNotice
  );

  const footer = (
    <div className="mt-6 space-y-1 text-center text-xs text-muted">
      <p>
        <Link href="/login" className="font-semibold hover:text-ink">
          Customer sign-in
        </Link>{" "}
        ·{" "}
        <Link href="/portals" className="font-semibold hover:text-ink">
          All portals
        </Link>
      </p>
      <p>
        Operator accounts are created by an admin. Lost your password? Ask an
        admin to reset it.
      </p>
    </div>
  );

  if (mode === "otp") {
    return (
      <div className="w-full max-w-sm">
        {header}
        {notices}
        <div className="mt-6">
          <OtpLogin
            next={landing}
            heading="Sign in with your phone"
            sub="The number this account is registered with."
          />
        </div>
        <div className="my-5 flex items-center gap-3 text-xs font-semibold text-muted">
          <span className="h-px flex-1 bg-line" /> OR{" "}
          <span className="h-px flex-1 bg-line" />
        </div>
        <button
          type="button"
          onClick={() => {
            setMode("password");
            setError(null);
          }}
          className="press flex h-14 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[15px] font-bold text-ink"
        >
          <Mail className="size-5" /> Email or mobile &amp; password
        </button>
        {footer}
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      {/* Outside the form, not inside it: `notices` carries the sign-out form,
          and a <form> within a <form> is invalid HTML and throws on hydration.
          Neither the heading nor the banner is form content anyway. */}
      {header}
      {notices}

      <form onSubmit={onSubmit}>
        <div className="mt-6 space-y-2.5">
          {/* Not type="email": the browser would refuse to submit a mobile
              number. `inputMode` stays text so an email is still typeable. */}
          <input
            type="text"
            required
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="h-14 w-full rounded-2xl bg-surface-2 px-4 text-[15px] font-medium outline-none ring-accent focus:ring-2"
            placeholder="Email or mobile number"
            aria-label="Email address or mobile number"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-14 w-full rounded-2xl bg-surface-2 px-4 text-[15px] font-medium outline-none ring-accent focus:ring-2"
            placeholder="Password"
          />
        </div>

        {error ? (
          <p className="mt-3 rounded-xl bg-deal-soft px-3 py-2.5 text-center text-sm font-medium text-deal">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="press mt-4 flex h-14 w-full items-center justify-center rounded-full bg-accent text-[17px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)] disabled:opacity-50"
        >
          {busy ? "Signing in…" : `Sign in to ${portal.label.toLowerCase()}`}
        </button>

        {portal.otp ? (
          <>
            <div className="my-5 flex items-center gap-3 text-xs font-semibold text-muted">
              <span className="h-px flex-1 bg-line" /> OR{" "}
              <span className="h-px flex-1 bg-line" />
            </div>
            <button
              type="button"
              onClick={() => {
                setMode("otp");
                setError(null);
              }}
              className="press flex h-14 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[15px] font-bold text-ink"
            >
              <Smartphone className="size-5" /> Login with OTP
            </button>
          </>
        ) : null}
      </form>

      {footer}
    </div>
  );
}
