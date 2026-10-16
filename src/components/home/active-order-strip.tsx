"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { Order } from "@/types";
import { STATUS_META } from "@/lib/utils/order-status";
import { pick } from "@/lib/i18n/lang";
import { useLang } from "@/components/providers/lang-provider";
import { PhotoTile } from "@/components/shared/photo-tile";

/** Bolt-style ongoing-order card — a calm white row with a live green dot. */
export function ActiveOrderStrip({ order }: Readonly<{ order: Order | null }>) {
  const { lang, t } = useLang();
  if (!order) return null;

  const meta = STATUS_META[order.status];
  const tint =
    order.restaurantAccent ?? "linear-gradient(135deg,#34e39a,#17b26a)";
  const image = order.restaurantImage;

  return (
    <Link
      href={`/orders/${order.id}`}
      className="press flex items-center gap-3 rounded-2xl border border-line bg-surface p-3"
    >
      <PhotoTile
        tint={tint}
        src={image}
        alt={order.restaurantName}
        className="size-12 shrink-0 rounded-xl"
        sizes="48px"
      />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-bold text-green">
          <span className="inline-block size-2 animate-pulse rounded-full bg-green" />
          {t("Ongoing order", "चालू ऑर्डर")} · {pick(lang, meta)}
        </span>
        <p className="mt-0.5 truncate text-[15px] font-extrabold tracking-tight">
          {order.restaurantName}
        </p>
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted" />
    </Link>
  );
}
