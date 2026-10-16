"use client";

import { Printer } from "lucide-react";
import type { UiOrder } from "@/lib/utils/order-map";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatINR } from "@/lib/utils/format";
import { useT } from "@/components/providers/lang-provider";
import type { T } from "@/lib/i18n/lang";

/**
 * What the customer paid, itemised, on a page that survives leaving the screen.
 *
 * There was no receipt anywhere in the customer app. Every number needed for
 * one was already on the order — line items, delivery fee, tax, tip, discount,
 * the coupon code, how it was paid — and the only place any of it appeared was
 * a single "Total (Cash)" line on the tracking screen. Anyone who had to expense
 * a delivery, or reconcile a card statement, had nothing to produce.
 *
 * Print rather than a generated PDF, for the same reason the admin reports
 * print (see globals.css): the browser already has a typesetter and a
 * PDF writer, and every phone's share sheet offers "Save as PDF" from it. A
 * bundled renderer would ship a megabyte to reproduce that badly.
 */
export function OrderReceipt({
  order,
  placedOn,
}: Readonly<{
  order: UiOrder;
  /**
   * The full date, formatted on the server so it does not depend on the
   * device's locale settings for a document meant to be filed.
   */
  placedOn: string;
}>) {
  const t = useT();
  const charges = order.charges;
  const paidWith = paidWithLabel(order, t);

  return (
    <div className="admin-measure mx-auto px-4 pb-8">
      <div className="card mt-2 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-muted">
              Deligro
            </p>
            <h1 className="mt-1 text-[22px] font-extrabold tracking-tight">
              {t("Receipt", "रसीद")}
            </h1>
          </div>
          <div className="text-right">
            <p className="text-data text-[13px] font-extrabold tracking-[0.1em]">
              {shortOrderId(order.id)}
            </p>
            <p className="mt-0.5 text-[12px] text-muted">{placedOn}</p>
          </div>
        </div>

        <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t("Restaurant", "रेस्टोरेंट")}</dt>
            <dd className="text-right font-semibold">{order.restaurantName}</dd>
          </div>
          {order.address?.line ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted">
                {t("Delivered to", "डिलीवरी का पता")}
              </dt>
              <dd className="text-right font-semibold">
                {order.address.label ? `${order.address.label} — ` : ""}
                {order.address.line}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t("Payment", "भुगतान")}</dt>
            <dd className="text-right font-semibold">{paidWith}</dd>
          </div>
        </dl>

        <table className="mt-5 w-full text-[14px]">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-[0.06em] text-muted">
              <th className="pb-2 text-left font-bold">{t("Item", "आइटम")}</th>
              <th className="pb-2 text-right font-bold">
                {t("Qty", "मात्रा")}
              </th>
              <th className="pb-2 text-right font-bold">
                {t("Amount", "रकम")}
              </th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => (
              <tr key={l.itemId} className="border-b border-line/60">
                <td className="py-2 pr-2">{l.name}</td>
                <td className="py-2 text-right text-muted">{l.qty}</td>
                <td className="text-data py-2 text-right">
                  {formatINR(l.price * l.qty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Absent on a mock order, and on a database that predates the
            migrations these fields arrived in. The total is always real, so a
            receipt without the breakdown still says what was paid rather than
            inventing the parts. */}
        {charges ? (
          <dl className="mt-4 space-y-1.5 text-[14px]">
            <Row label={t("Subtotal", "कुल सामान")} value={charges.subtotal} />
            {charges.discount > 0 ? (
              <Row
                label={
                  charges.couponCode
                    ? t(
                        `Discount (${charges.couponCode})`,
                        `छूट (${charges.couponCode})`,
                      )
                    : t("Discount", "छूट")
                }
                value={-charges.discount}
              />
            ) : null}
            <Row label={t("Delivery", "डिलीवरी")} value={charges.deliveryFee} />
            {charges.tax > 0 ? (
              <Row label={t("Taxes", "टैक्स")} value={charges.tax} />
            ) : null}
            {charges.tip > 0 ? (
              <Row
                label={t("Tip for the rider", "राइडर के लिए टिप")}
                value={charges.tip}
              />
            ) : null}
          </dl>
        ) : null}

        <div className="mt-3 flex justify-between border-t border-line pt-3">
          <span className="text-[15px] font-extrabold">
            {t("Total", "कुल")}
          </span>
          <span className="text-data text-[17px] font-extrabold">
            {formatINR(order.total)}
          </span>
        </div>

        <p className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
          {t(
            "This is a customer receipt for an order placed through Deligro. Prices are in Indian rupees and include any taxes shown above.",
            "यह Deligro से किए गए ऑर्डर की ग्राहक रसीद है। सभी दाम भारतीय रुपये में हैं और ऊपर दिखाए गए टैक्स इनमें शामिल हैं।",
          )}
        </p>
      </div>

      <button
        type="button"
        onClick={() => window.print()}
        data-print="hide"
        className="press mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-accent py-3.5 text-sm font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)]"
      >
        <Printer className="size-4" />
        {t("Print or save as PDF", "प्रिंट करें या पीडीएफ़ सेव करें")}
      </button>
    </div>
  );
}

/** How the order was paid, as the receipt words it. */
function paidWithLabel(order: UiOrder, t: T): string {
  if (order.paymentMethod !== "online") {
    return t("Cash on delivery", "डिलीवरी पर नकद");
  }
  return order.paymentStatus === "paid"
    ? t("Paid online", "ऑनलाइन भुगतान हो गया")
    : t("Online payment", "ऑनलाइन भुगतान");
}

function Row({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-data">
        {value < 0 ? `−${formatINR(-value)}` : formatINR(value)}
      </dd>
    </div>
  );
}
