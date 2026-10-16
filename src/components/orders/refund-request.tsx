"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalToShell } from "@/components/shared/portal-to-shell";
import { formatINR } from "@/lib/utils/format";
import { useT } from "@/components/providers/lang-provider";

/**
 * "Request a refund" on a finished order.
 *
 * The refunds table has been in the schema since 0001 with a policy letting a
 * customer request one, and until now nothing in the app ever called it — the
 * admin queue could only ever be empty because there was no way to ask. This is
 * the ask.
 *
 * The amount is not here on purpose. The server reads it from `orders.total`;
 * this component knows the total only so it can tell the customer what they are
 * asking for. `paid` changes the words, not the offer: a cash order is just as
 * refundable, it is simply settled by a person rather than by the gateway, and
 * saying so up front is the difference between a wait and a complaint.
 */
export function RefundRequest({
  orderId,
  orderTotal,
  paid,
}: Readonly<{
  orderId: string;
  orderTotal: number;
  paid: boolean;
}>) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when this session made the request AND when the server says one is
  // already open — the second is how the button stays disabled across a reload,
  // since the answer lives on the server rather than in a prop.
  const [requested, setRequested] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, reason: reason.trim() || undefined }),
      });

      if (res.ok) {
        setRequested(true);
        setOpen(false);
        router.refresh();
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { error?: string };

      // Already open is not a failure — it is the state the button was trying
      // to reach, so show it rather than an error the customer can't act on.
      if (data.error === "already_requested") {
        setRequested(true);
        setOpen(false);
        return;
      }

      setError(
        res.status === 429
          ? t(
              "Too many requests. Wait a moment and try again.",
              "बहुत ज़्यादा कोशिशें हुईं। थोड़ा रुककर फिर कोशिश करें।",
            )
          : data.error === "invalid_state"
            ? t(
                "Refunds can only be requested once an order is delivered or cancelled.",
                "रिफ़ंड तभी माँग सकते हैं जब ऑर्डर डिलीवर या कैंसिल हो चुका हो।",
              )
            : data.error === "not_found"
              ? t("We couldn't find this order.", "यह ऑर्डर नहीं मिला।")
              : data.error === "unauthorized"
                ? t(
                    "Your session expired. Sign in and try again.",
                    "आपका सेशन खत्म हो गया। लॉग इन करके फिर कोशिश करें।",
                  )
                : t(
                    "Couldn't send the request. Try again.",
                    "रिक्वेस्ट नहीं भेज पाए। फिर कोशिश करें।",
                  ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (requested) {
    return (
      <p className="flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-muted">
        <Check className="size-4 text-green" />
        {t(
          "Refund requested · we're reviewing it",
          "रिफ़ंड माँगा गया · हम इसे देख रहे हैं",
        )}
      </p>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="press flex w-full items-center justify-center gap-2 rounded-full border border-line bg-surface py-3.5 text-sm font-bold text-ink"
      >
        <RotateCcw className="size-4" />{" "}
        {t("Request a refund", "रिफ़ंड माँगें")}
      </button>

      {open ? (
        // Portalled out, not rendered in place. This button lives inside the
        // tracking screen's draggable `TrackingSheet`, whose `transform` makes
        // it the containing block for `position: fixed` — so `fixed inset-0`
        // meant "the sheet's box", which is pushed down by the sheet's offset
        // and clipped by the stage's `overflow-hidden`. The dialog's bottom
        // (the "Send request" button) landed off-screen and under the tab bar,
        // leaving only a squashed textarea visible. In `.app-shell` it covers
        // the phone screen and sits above the tab bar (z-30).
        <PortalToShell>
          <div className="fixed inset-0 z-50">
            <button
              type="button"
              aria-label={t("Close", "बंद करें")}
              onClick={() => setOpen(false)}
              className="animate-fade-in absolute inset-0 bg-ink/40"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="refund-request-title"
              className="bolt-sheet animate-sheet-in absolute inset-x-0 bottom-0 max-h-[calc(100%-1rem)] overflow-y-auto overscroll-contain p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 id="refund-request-title" className="text-heading">
                  {t("Request a refund", "रिफ़ंड माँगें")}
                </h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="press grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
                >
                  <X className="size-5" />
                </button>
              </div>

              <p className="text-sm leading-relaxed text-muted">
                {t(
                  "We'll review your request for the full order —",
                  "हम पूरे ऑर्डर के लिए आपकी रिक्वेस्ट देखेंगे —",
                )}{" "}
                <span className="text-data font-semibold text-ink">
                  {formatINR(orderTotal)}
                </span>
                .{" "}
                {paid
                  ? t(
                      "If it's approved the money goes back to however you paid.",
                      "मंज़ूरी मिलने पर पैसे उसी तरीके से वापस आएँगे जिससे आपने भुगतान किया था।",
                    )
                  : t(
                      "This order was paid in cash, so an approved refund is settled by our team directly rather than through the app.",
                      "इस ऑर्डर का भुगतान नकद हुआ था, इसलिए मंज़ूर रिफ़ंड ऐप से नहीं, सीधे हमारी टीम देगी।",
                    )}
              </p>

              <label
                htmlFor="refund-reason"
                className="mt-4 block text-xs font-semibold text-muted"
              >
                {t("What went wrong?", "क्या गड़बड़ हुई?")}
              </label>
              <textarea
                id="refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder={t(
                  "Missing items, food arrived cold, never delivered…",
                  "सामान कम आया, खाना ठंडा था, डिलीवरी नहीं हुई…",
                )}
                className="mt-1.5 w-full resize-none rounded-xl bg-surface-2 px-3.5 py-3 text-base outline-none focus:ring-2 focus:ring-accent/30"
              />

              {error ? <p className="mt-2 text-sm text-deal">{error}</p> : null}

              <Button
                className="mt-4 w-full"
                disabled={busy || reason.trim().length === 0}
                onClick={submit}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  t("Send request", "रिक्वेस्ट भेजें")
                )}
              </Button>
            </div>
          </div>
        </PortalToShell>
      ) : null}
    </>
  );
}
