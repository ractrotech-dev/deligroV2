"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { fieldCls, labelCls } from "@/components/ui/field";
import {
  offerBadgeText,
  type PromotionFunding,
  type PromotionKind,
} from "@/lib/promotion-rules";
import type { Promotion } from "@/lib/data-access/promotions";

export interface PromotionFormResult {
  ok: boolean;
  error?: string;
}

interface RestaurantOption {
  id: string;
  name: string;
}

/**
 * Create / edit a promo code. One component, two consumers: the admin console,
 * where a code may be platform-wide and the shop is a dropdown, and the
 * vendor's own screen, where the shop is fixed and the funding is not a choice.
 *
 * The shared form is the point. Two copies of these nine fields would be two
 * places to forget a cap, and a promotion with a forgotten cap is money.
 *
 * The right rail shows the badge the shop's card will carry. That is a preview
 * of a derived value — `refresh_restaurant_offer()` in migration 0041 writes
 * the real one — so it exists to make the consequence visible at the moment of
 * choosing, not to be the source of it.
 */
export function PromotionForm({
  action,
  promotion,
  restaurants,
  fixedRestaurant,
  cancelHref,
}: Readonly<{
  action: (prev: PromotionFormResult, form: FormData) => Promise<PromotionFormResult>;
  promotion?: Promotion;
  /** Admin mode: every shop, plus "works everywhere". */
  restaurants?: RestaurantOption[];
  /** Vendor mode: the shop is decided by who is signed in. */
  fixedRestaurant?: RestaurantOption;
  cancelHref: string;
}>) {
  const editing = Boolean(promotion);
  const [state, formAction, pending] = useActionState<PromotionFormResult, FormData>(
    action,
    { ok: false }
  );

  const [kind, setKind] = useState<PromotionKind>(promotion?.kind ?? "percent");
  const [value, setValue] = useState(String(promotion?.value ?? 20));
  const [minOrder, setMinOrder] = useState(String(promotion?.minOrder ?? 199));
  const [maxDiscount, setMaxDiscount] = useState(
    promotion?.maxDiscount != null ? String(promotion.maxDiscount) : "120"
  );
  const [restaurantId, setRestaurantId] = useState(
    promotion?.restaurantId ?? fixedRestaurant?.id ?? ""
  );
  const [fundedBy, setFundedBy] = useState<PromotionFunding>(
    promotion?.fundedBy ?? (fixedRestaurant ? "vendor" : "platform")
  );

  const num = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };

  const badge = offerBadgeText({
    kind,
    value: num(value),
    maxDiscount: kind === "percent" && maxDiscount.trim() ? num(maxDiscount) : null,
    minOrder: num(minOrder),
  });

  // A shop's card only advertises a code that works at that shop — a
  // platform-wide code decorating one restaurant while the identical offer at
  // the shop next door shows nothing would be worse than no badge at all.
  const showsBadge = Boolean(restaurantId);
  const submitLabel = editing ? "Save changes" : "Create code";

  return (
    <form action={formAction} className="grid gap-5 @4xl:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <section className="space-y-3.5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-bold tracking-[-0.01em]">The code</h2>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={labelCls}>Code customers type</span>
              <input
                name="code"
                defaultValue={promotion?.code ?? ""}
                // The primary key, and printed on things by the time anyone
                // wants to change it. Retire a code and make a new one.
                readOnly={editing}
                required
                placeholder="SAVE20"
                maxLength={24}
                className={`${fieldCls} font-mono uppercase tracking-[0.08em] ${
                  editing ? "opacity-60" : ""
                }`}
                onChange={(e) => {
                  e.target.value = e.target.value.toUpperCase().replace(/\s+/g, "");
                }}
              />
              <span className="block text-[11.5px] text-muted">
                {editing
                  ? "A live code can't be renamed — customers may already have it."
                  : "4–24 letters and numbers. Customers type this at checkout."}
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className={labelCls}>Campaign name</span>
              <input
                name="label"
                defaultValue={promotion?.label ?? ""}
                placeholder="Diwali week"
                className={fieldCls}
              />
              <span className="block text-[11.5px] text-muted">
                For your own records. Customers never see it.
              </span>
            </label>
          </div>
        </section>

        <section className="space-y-3.5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-bold tracking-[-0.01em]">
            What comes off
          </h2>

          <div className="grid gap-3.5 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className={labelCls}>Type</span>
              <select
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as PromotionKind)}
                className={fieldCls}
              >
                <option value="percent">Percentage off</option>
                <option value="flat">Flat rupees off</option>
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className={labelCls}>
                {kind === "percent" ? "Percent off" : "Rupees off"}
              </span>
              <input
                name="value"
                type="number"
                min={1}
                max={kind === "percent" ? 100 : undefined}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                className={fieldCls}
              />
            </label>

            <label className="block space-y-1.5">
              <span className={labelCls}>Minimum food bill (₹)</span>
              <input
                name="minOrder"
                type="number"
                min={0}
                value={minOrder}
                onChange={(e) => setMinOrder(e.target.value)}
                className={fieldCls}
              />
            </label>
          </div>

          {kind === "percent" ? (
            <label className="block space-y-1.5">
              <span className={labelCls}>Cap in rupees</span>
              <input
                name="maxDiscount"
                type="number"
                min={1}
                value={maxDiscount}
                onChange={(e) => setMaxDiscount(e.target.value)}
                className={`${fieldCls} sm:max-w-[12rem]`}
              />
              <span className="block text-[11.5px] text-muted">
                The most this code can ever take off one order. Required at 50%
                and above — without it a ₹4,000 party order costs you ₹2,000.
              </span>
            </label>
          ) : null}
        </section>

        <section className="space-y-3.5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-bold tracking-[-0.01em]">
            How far it goes
          </h2>

          <div className="grid gap-3.5 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className={labelCls}>Uses per customer</span>
              <input
                name="maxPerCustomer"
                type="number"
                min={1}
                defaultValue={
                  promotion?.maxPerCustomer != null
                    ? String(promotion.maxPerCustomer)
                    : "1"
                }
                placeholder="Unlimited"
                className={fieldCls}
              />
              <span className="block text-[11.5px] text-muted">
                Blank means unlimited — a permanent price cut for anyone who
                keeps typing it.
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className={labelCls}>Total redemptions</span>
              <input
                name="maxRedemptions"
                type="number"
                min={1}
                defaultValue={
                  promotion?.maxRedemptions != null
                    ? String(promotion.maxRedemptions)
                    : ""
                }
                placeholder="Unlimited"
                className={fieldCls}
              />
              <span className="block text-[11.5px] text-muted">
                The campaign retires itself once this many are claimed.
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className={labelCls}>Ends</span>
              <input
                name="expiresAt"
                type="datetime-local"
                defaultValue={toLocalInput(promotion?.expiresAt)}
                className={fieldCls}
              />
              <span className="block text-[11.5px] text-muted">
                Blank runs until you switch it off.
              </span>
            </label>
          </div>
        </section>

        {restaurants ? (
          <section className="space-y-3.5 rounded-xl border border-line bg-surface p-4">
            <h2 className="text-[15px] font-bold tracking-[-0.01em]">
              Where it works, and who pays
            </h2>

            <div className="grid gap-3.5 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className={labelCls}>Shop</span>
                <select
                  name="restaurantId"
                  value={restaurantId}
                  onChange={(e) => {
                    setRestaurantId(e.target.value);
                    // Nobody to bill without a shop. Mirrors the check
                    // constraint rather than waiting for it to fire.
                    if (!e.target.value) setFundedBy("platform");
                  }}
                  disabled={editing}
                  className={fieldCls}
                >
                  <option value="">Every shop on Deligro</option>
                  {restaurants.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1.5">
                <span className={labelCls}>Funded by</span>
                <select
                  name="fundedBy"
                  value={fundedBy}
                  onChange={(e) => setFundedBy(e.target.value as PromotionFunding)}
                  disabled={editing || !restaurantId}
                  className={fieldCls}
                >
                  <option value="platform">Deligro</option>
                  <option value="vendor">The shop</option>
                </select>
                <span className="block text-[11.5px] text-muted">
                  Decides whose money it is at settlement. A shop-funded
                  discount comes out of that shop&rsquo;s item revenue; a
                  Deligro-funded one does not.
                </span>
              </label>
            </div>

            {editing ? (
              <p className="text-[11.5px] text-muted">
                Scope and funding are fixed once a code exists — both are
                recorded on every order that used it, and changing them now
                would make the settlement history unreadable.
              </p>
            ) : null}
          </section>
        ) : (
          <>
            {/* Vendor mode. The shop is whoever is signed in, and the funding
                is not a question — the server pins both regardless of what
                arrives in the form. */}
            <input type="hidden" name="restaurantId" value={fixedRestaurant?.id ?? ""} />
            <input type="hidden" name="fundedBy" value="vendor" />
          </>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="active"
              defaultChecked={promotion?.active ?? true}
              className="size-4 accent-[var(--c-accent)]"
            />{" "}
            Live now
          </label>
          <div className="flex-1" />
          <Link href={cancelHref} className="c-btn press">
            Cancel
          </Link>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
        </div>

        {state.error ? (
          <p className="rounded-lg border border-deal/30 bg-deal/10 px-3 py-2 text-sm text-deal">
            {state.error}
          </p>
        ) : null}
      </div>

      <aside className="space-y-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className={labelCls}>On the shop&rsquo;s card</p>
          {showsBadge ? (
            <>
              <span className="mt-2 inline-flex rounded-md bg-[var(--c-accent)]/12 px-2 py-1 text-[12.5px] font-bold text-[var(--c-accent)]">
                {badge}
              </span>
              <p className="mt-2 text-[11.5px] text-muted">
                Written by the database from this code, not typed. It clears
                itself when the code expires or is switched off.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted">
              A code that works everywhere doesn&rsquo;t badge any one shop.
              Customers reach it from a campaign banner or by typing it.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface p-4">
          <p className={labelCls}>At checkout</p>
          <dl className="mt-2 space-y-1 text-[12.5px]">
            <Row k="Food bill" v={`₹${Math.max(num(minOrder), 400)}`} />
            <Row
              k="This code takes off"
              v={`−₹${exampleDiscount(kind, num(value), maxDiscount, num(minOrder))}`}
            />
          </dl>
          <p className="mt-2 text-[11.5px] text-muted">
            Delivery and tax are never discounted — somebody still rides the
            order out to the door.
          </p>
        </div>
      </aside>
    </form>
  );
}

function Row({ k, v }: Readonly<{ k: string; v: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="font-semibold tabular-nums">{v}</dd>
    </div>
  );
}

/** What this code would take off a basket just clearing its own minimum. */
function exampleDiscount(
  kind: PromotionKind,
  value: number,
  maxDiscount: string,
  minOrder: number
): number {
  const basket = Math.max(minOrder, 400);
  if (kind === "flat") return Math.min(Math.round(value), basket);
  const raw = Math.round((basket * value) / 100);
  const cap = maxDiscount.trim() ? Number(maxDiscount) : null;
  return Math.min(cap && Number.isFinite(cap) ? cap : raw, raw, basket);
}

/** ISO → the `datetime-local` shape, in the viewer's own zone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
