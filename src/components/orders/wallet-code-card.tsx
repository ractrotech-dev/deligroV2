"use client";

import { useState } from "react";
import { Coins, Loader2 } from "lucide-react";
import { useLang } from "@/components/providers/lang-provider";

/**
 * During a cash delivery: if the rider has no change, the customer reads out a code and
 * the leftover goes to their wallet as points. The code exists only in the answer to
 * this request, so it lives in this screen's state; asking again makes a new one.
 */
export function WalletCodeCard({ orderId }: Readonly<{ orderId: string }>) {
  const { t } = useLang();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function getCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/wallet-code`, { method: "POST" });
      const data = (await res.json()) as { code?: string; message?: string };
      if (res.ok && data.code) {
        setCode(data.code);
      } else {
        setCode(null);
        setError(data.message ?? t("Couldn't get a code. Please try again.", "कोड नहीं मिल पाया। कृपया फिर कोशिश करें।"));
      }
    } catch {
      setError(t("Couldn't get a code. Check your internet and try again.", "कोड नहीं मिल पाया। इंटरनेट देखकर फिर कोशिश करें।"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Coins className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold">{t("Rider has no change?", "राइडर के पास छुट्टे नहीं हैं?")}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-muted">
            {t(
              "Tell the rider this code. Your change goes to your wallet as points, to use on your next order.",
              "राइडर को यह कोड बताएं। आपके बचे पैसे वॉलेट में पॉइंट बनकर जुड़ जाएंगे, जिन्हें अगले ऑर्डर में इस्तेमाल कर सकते हैं।",
            )}
          </p>
        </div>
      </div>
      {code ? (
        <div className="mt-3 rounded-xl bg-surface-2 px-3 py-3 text-center">
          <p className="text-data text-[28px] font-extrabold tracking-[0.3em]">{code}</p>
          <p className="mt-1 text-xs text-muted">{t("Works for 10 minutes.", "10 मिनट तक चलेगा।")}</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] font-medium text-deal">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={getCode}
        disabled={busy}
        className="press mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3 text-sm font-bold disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {code ? t("Get a new code", "नया कोड लें") : t("Get code", "कोड लें")}
      </button>
    </div>
  );
}
