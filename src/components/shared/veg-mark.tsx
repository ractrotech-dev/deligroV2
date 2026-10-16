"use client";

import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/**
 * The familiar veg / non-veg square used across Indian food apps.
 *
 * Renders nothing when `veg` is undefined. That case is real — a dish deleted
 * from the menu leaves a past order with no flag — and showing a green square by
 * default would be telling someone that a chicken biryani is vegetarian.
 */
export function VegMark({
  veg,
  className,
}: Readonly<{
  veg?: boolean;
  className?: string;
}>) {
  const t = useT();
  if (typeof veg !== "boolean") return null;

  const color = veg ? "var(--green)" : "var(--accent)";
  return (
    <span
      aria-label={
        veg ? t("Vegetarian", "शाकाहारी") : t("Non-vegetarian", "मांसाहारी")
      }
      className={cn(
        "inline-grid place-items-center rounded-[3px] border",
        "size-[14px] shrink-0",
        className,
      )}
      style={{ borderColor: color }}
    >
      <span
        className="block rounded-full"
        style={{ background: color, width: 6, height: 6 }}
      />
    </span>
  );
}
