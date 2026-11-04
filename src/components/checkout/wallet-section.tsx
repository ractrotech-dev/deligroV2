"use client";

import { Coins } from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import type { T } from "@/lib/i18n/lang";

/**
 * "Use my wallet" at checkout. 1 point = ₹1. The customer picks any whole amount up to
 * their balance and the bill. A preview: the server takes the points under a lock when
 * the order is placed.
 */
export function WalletSection({
  balance,
  max,
  use,
  amount,
  cashDue,
  online,
  t,
  onUse,
  onAmount,
}: Readonly<{
  balance: number;
  /** The most they can use on this bill. */
  max: number;
  use: boolean;
  /** Text in the amount box. */
  amount: string;
  /** What is left for the rider to collect. */
  cashDue: number;
  /** Paying online: points don't combine with the gateway yet. */
  online: boolean;
  t: T;
  onUse: (use: boolean) => void;
  onAmount: (amount: string) => void;
}>) {
  return (
    <section className="card p-4">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Coins className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold">{t("Use my wallet", "मेरा वॉलेट इस्तेमाल करें")}</p>
          <p className="text-xs text-muted">
            {t(`You have ${Math.floor(balance)} points (1 point = ₹1)`, `आपके पास ${Math.floor(balance)} पॉइंट हैं (1 पॉइंट = ₹1)`)}
          </p>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("Use my wallet", "मेरा वॉलेट इस्तेमाल करें")}
          checked={use && !online}
          disabled={online}
          onChange={(e) => onUse(e.target.checked)}
          className="size-5 shrink-0 accent-[var(--accent)] disabled:opacity-50"
        />
      </div>
      {online ? (
        <p className="mt-2 text-xs text-muted">
          {t("Points can only be used on cash orders for now.", "अभी पॉइंट सिर्फ़ नकद ऑर्डर पर इस्तेमाल हो सकते हैं।")}
        </p>
      ) : null}
      {use && !online ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <label className="flex items-center justify-between gap-3 text-sm font-semibold">
            {t("Points to use", "कितने पॉइंट")}
            <input
              inputMode="numeric"
              value={amount}
              onChange={(e) => onAmount(e.target.value.replace(/\D/g, ""))}
              onBlur={() => onAmount(String(Math.min(Number(amount) || 0, max)))}
              className="w-24 rounded-xl border border-line bg-surface px-3 py-2 text-right text-base font-bold"
              aria-describedby="wallet-points-max"
            />
          </label>
          <p id="wallet-points-max" className="text-xs text-muted">
            {t(`You can use up to ${max} on this order.`, `इस ऑर्डर पर ${max} तक इस्तेमाल कर सकते हैं।`)}
          </p>
          <p className="text-[13px] font-semibold">
            {cashDue > 0
              ? t(`Pay the rider ${formatINR(cashDue)} in cash.`, `राइडर को ${formatINR(cashDue)} नकद दें।`)
              : t("Your points cover this order. Nothing to pay the rider.", "आपके पॉइंट से पूरा ऑर्डर हो गया। राइडर को कुछ नहीं देना।")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
