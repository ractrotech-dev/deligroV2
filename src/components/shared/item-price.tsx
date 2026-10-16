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
}: Readonly<{
  item: Pick<MenuItem, "price" | "discountPrice">;
  qty?: number;
}>) {
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
