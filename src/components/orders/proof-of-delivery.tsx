"use client";

import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import { useLang } from "@/components/providers/lang-provider";

/** The signed URL lives 10 minutes; a page left open is given a fresh one before that. */
const REFRESH_MS = 8 * 60_000;

/**
 * "Proof of delivery" — a link to the photo the rider took at the door.
 *
 * It asks `GET /api/orders/:id/proof` once the order is delivered, and draws
 * nothing unless that answers with a link: no photo (404), a rider who was not
 * asked for one, a database without 0082 and a transient failure all look the
 * same here — there is nothing to show. The URL is a short-lived signed one for
 * the private bucket, so it is renewed while the page stays open and never
 * stored.
 */
export function ProofOfDelivery({ orderId }: Readonly<{ orderId: string }>) {
  const { t } = useLang();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/proof`, { cache: "no-store" });
        if (!live) return;
        if (!res.ok) {
          setUrl(null);
          return;
        }
        const data = (await res.json()) as { url?: unknown };
        if (live) setUrl(typeof data.url === "string" ? data.url : null);
      } catch {
        // Keep whatever link we have; it expires on its own.
      }
    };
    const first = setTimeout(() => void load(), 0);
    const again = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(again);
    };
  }, [orderId]);

  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="press flex items-center justify-center gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-[15px] font-bold text-accent-ink"
    >
      <Camera className="size-4" />
      {t("Proof of delivery", "डिलीवरी का सबूत")}
    </a>
  );
}
