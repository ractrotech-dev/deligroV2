import type { MenuItem } from "@/types";
import { effectivePrice } from "@/lib/utils/cart";
import { formatINR } from "@/lib/utils/format";

/**
 * A dish's price, struck-through against the original when a discount price
 * actually applies. One place for this so the menu row, the item sheet and
 * search's dish card can never show the discount differently from each other
 * — or differently from what `effectivePrice` will actually charge.
 */
export function ItemPrice({
  item,
  qty = 1,
  fromLabel = "from",
}: Readonly<{
  item: Pick<MenuItem, "price" | "discountPrice" | "variants">;
  qty?: number;
  /** "from" in the reader's language, for a dish priced by its sizes. */
  fromLabel?: string;
}>) {
  // A dish with sizes costs what the size costs; show the cheapest.
  const sizes = (item.variants ?? []).filter((v) => v.available).map((v) => v.price);
  if (sizes.length > 0) return <>{fromLabel} {formatINR(Math.min(...sizes) * qty)}</>;

  const price = effectivePrice(item.price, item.discountPrice);
  const discounted = price < item.price;

  if (!discounted) return <>{formatINR(price * qty)}</>;

  return (
    <>
      <span className="mr-1.5 text-muted line-through">
        {formatINR(item.price * qty)}
      </span>
      {formatINR(price * qty)}
    </>
  );
}
