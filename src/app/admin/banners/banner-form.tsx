"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { fieldCls, labelCls } from "@/components/ui/field";
import { PromoBannerCarousel } from "@/components/home/promo-banner-carousel";
import { saveBannerAction, type ActionResult } from "./actions";
import type {
  Banner,
  BannerKind,
  BannerPlacement,
  BannerStatus,
  BannerTargetType,
} from "@/types";

// Was a local copy of the same two strings. Sharing them is what lets the
// console restyle every form at once — a private copy here would have left this
// screen's inputs at mobile proportions inside the console.
const field = fieldCls;

const PLACEMENTS: { id: BannerPlacement; label: string }[] = [
  { id: "home_hero", label: "Home · hero carousel" },
  { id: "home_food", label: "Home · food" },
  { id: "stores_top", label: "Stores · top" },
  { id: "grocery_top", label: "Grocery · top" },
  { id: "pharmacy_top", label: "Pharmacy · top" },
  { id: "checkout", label: "Checkout" },
];

const TARGETS: { id: BannerTargetType; label: string }[] = [
  { id: "food", label: "Food home" },
  { id: "grocery", label: "Grocery" },
  { id: "pick_drop", label: "Pick & Drop" },
  { id: "shops", label: "Shops" },
  { id: "pharmacy", label: "Pharmacy" },
  { id: "membership", label: "Membership" },
  { id: "refer", label: "Refer & Earn" },
  { id: "restaurant", label: "Specific restaurant (slug)" },
  { id: "store", label: "Specific store (slug)" },
  { id: "product", label: "Specific product (id)" },
  { id: "category", label: "Category" },
  { id: "external", label: "External URL" },
];

const TINTS = [
  "linear-gradient(135deg,#f2a71b,#d98600)",
  "linear-gradient(135deg,#17b26a,#0e8f57)",
  "linear-gradient(135deg,#3b82f6,#1d4ed8)",
  "linear-gradient(135deg,#e5352b,#b31217)",
  "linear-gradient(135deg,#f6c453,#e8552d)",
  "linear-gradient(135deg,#8b5cf6,#6d28d9)",
];

function Labeled({
  label,
  hint,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}>) {
  return (
    <label className="block space-y-1.5">
      <span className={labelCls}>{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * Create/edit a campaign. The right rail renders a live preview through the very
 * same `PromoBannerCarousel` the customer sees, so "what you configure" and
 * "what ships" can't drift.
 */
export function BannerForm({ banner }: Readonly<{ banner?: Banner }>) {
  const editing = Boolean(banner);
  const action = saveBannerAction.bind(null, banner?.id ?? "");
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    action,
    { ok: false }
  );

  // Live-preview state — only the fields that change what the slide looks like.
  const [headline, setHeadline] = useState(banner?.headline ?? "Your headline here");
  const [description, setDescription] = useState(
    banner?.description ?? "A short, two-line description of the promotion."
  );
  const [ctaLabel, setCtaLabel] = useState(banner?.ctaLabel ?? "Explore");
  const [kind, setKind] = useState<BannerKind>(banner?.kind ?? "internal");
  const [tint, setTint] = useState(banner?.tint ?? TINTS[0]);
  const [glyph, setGlyph] = useState(banner?.glyph ?? "🎉");
  const [imageUrl, setImageUrl] = useState(banner?.imageUrl ?? "");
  const [sponsorName, setSponsorName] = useState(banner?.sponsorName ?? "");
  const [targetType, setTargetType] = useState<BannerTargetType>(
    banner?.target.type ?? "food"
  );

  const preview = useMemo<Banner>(
    () => ({
      id: "preview",
      name: "preview",
      headline,
      description,
      ctaLabel,
      kind,
      status: "active",
      target: { type: "food" },
      placements: ["home_hero"],
      priority: 0,
      displayOrder: 0,
      autoSlideMs: 4500,
      imageUrl: imageUrl || undefined,
      tint,
      glyph: glyph || undefined,
      sponsorName: kind === "sponsored" ? sponsorName || "Sponsor" : undefined,
    }),
    [headline, description, ctaLabel, kind, tint, glyph, imageUrl, sponsorName]
  );

  const needsValue =
    targetType === "restaurant" ||
    targetType === "store" ||
    targetType === "product" ||
    targetType === "category" ||
    targetType === "external";

  const toLocal = (iso?: string | null) => {
    if (!iso) return "";
    // datetime-local wants "YYYY-MM-DDTHH:mm" — trim the ISO string's tail.
    return iso.slice(0, 16);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <form action={formAction} className="space-y-6">
        {state.error ? (
          <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
            {state.error}
          </p>
        ) : null}

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Content</h2>
          <Labeled label="Campaign name (internal)">
            <input name="name" defaultValue={banner?.name} className={field} required />
          </Labeled>
          <Labeled label="Headline">
            <input
              name="headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              className={field}
              required
            />
          </Labeled>
          <Labeled label="Description (max ~2 lines)">
            <textarea
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={field}
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="CTA label">
              <input
                name="ctaLabel"
                value={ctaLabel}
                onChange={(e) => setCtaLabel(e.target.value)}
                className={field}
              />
            </Labeled>
            <Labeled label="Emoji / glyph">
              <input
                name="glyph"
                value={glyph}
                onChange={(e) => setGlyph(e.target.value)}
                className={field}
                maxLength={4}
              />
            </Labeled>
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Artwork</h2>
          <Labeled
            label="Desktop image URL"
            hint="Must be on images.unsplash.com or Supabase storage — the browser silently blocks images from other hosts, per the app's content security policy."
          >
            <input
              name="imageUrl"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className={field}
              placeholder="https://…"
            />
          </Labeled>
          <Labeled label="Mobile image URL (optional)">
            <input
              name="mobileImageUrl"
              defaultValue={banner?.mobileImageUrl}
              className={field}
              placeholder="https://… (falls back to desktop)"
            />
          </Labeled>
          <div className="space-y-1.5">
            <span className={labelCls}>Fallback gradient</span>
            <div className="flex flex-wrap gap-2">
              {TINTS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTint(t)}
                  aria-label="Pick gradient"
                  className={`h-9 w-14 rounded-lg ring-2 transition ${
                    tint === t ? "ring-accent" : "ring-transparent"
                  }`}
                  style={{ background: t }}
                />
              ))}
            </div>
            <input type="hidden" name="tint" value={tint} />
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Type &amp; destination</h2>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Campaign type">
              <select
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as BannerKind)}
                className={field}
              >
                <option value="internal">Internal · Deligro promo</option>
                <option value="sponsored">Paid · Sponsored ad</option>
              </select>
            </Labeled>
            <Labeled label="Status">
              <select
                name="status"
                defaultValue={banner?.status ?? "draft"}
                className={field}
              >
                {(["draft", "active", "paused", "archived"] as BannerStatus[]).map(
                  (s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  )
                )}
              </select>
            </Labeled>
          </div>
          {kind === "sponsored" ? (
            <Labeled label="Sponsor name (shown on the badge)">
              <input
                name="sponsorName"
                value={sponsorName}
                onChange={(e) => setSponsorName(e.target.value)}
                className={field}
              />
            </Labeled>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Redirects to">
              <select
                name="targetType"
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as BannerTargetType)}
                className={field}
              >
                {TARGETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label={needsValue ? "Target value (required)" : "Target value"}>
              <input
                name="targetValue"
                defaultValue={banner?.target.value}
                className={field}
                placeholder="slug / id / URL"
              />
            </Labeled>
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Placement &amp; order</h2>
          <div className="space-y-1.5">
            <span className={labelCls}>Show on</span>
            <div className="grid grid-cols-2 gap-2">
              {PLACEMENTS.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm font-medium"
                >
                  <input
                    type="checkbox"
                    name={`placement:${p.id}`}
                    defaultChecked={banner?.placements.includes(p.id)}
                    className="size-4 accent-accent"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Labeled label="Priority">
              <input
                type="number"
                name="priority"
                defaultValue={banner?.priority ?? 0}
                className={field}
              />
            </Labeled>
            <Labeled label="Display order">
              <input
                type="number"
                name="displayOrder"
                defaultValue={banner?.displayOrder ?? 0}
                className={field}
              />
            </Labeled>
            <Labeled label="Auto-slide (ms)">
              <input
                type="number"
                name="autoSlideMs"
                defaultValue={banner?.autoSlideMs ?? 4500}
                min={3000}
                max={8000}
                step={500}
                className={field}
              />
            </Labeled>
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Schedule &amp; targeting</h2>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Starts at">
              <input
                type="datetime-local"
                name="startsAt"
                defaultValue={toLocal(banner?.startsAt)}
                className={field}
              />
            </Labeled>
            <Labeled label="Ends at">
              <input
                type="datetime-local"
                name="endsAt"
                defaultValue={toLocal(banner?.endsAt)}
                className={field}
              />
            </Labeled>
          </div>
          <Labeled label="Cities (comma-separated)">
            <input
              name="targetCities"
              defaultValue={banner?.targeting?.cities?.join(", ")}
              className={field}
              placeholder="Bemetara, Raipur"
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Delivery zones">
              <input
                name="targetZones"
                defaultValue={banner?.targeting?.zones?.join(", ")}
                className={field}
              />
            </Labeled>
            <Labeled label="User segments">
              <input
                name="targetSegments"
                defaultValue={banner?.targeting?.segments?.join(", ")}
                className={field}
                placeholder="new, vip"
              />
            </Labeled>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create campaign"}
          </Button>
          <Link href="/admin/banners">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
        </div>
      </form>

      <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <p className={labelCls}>Live preview</p>
        <div className="rounded-3xl border border-line bg-bg p-3">
          <PromoBannerCarousel
            banners={[preview]}
            placement="preview"
            analytics={false}
          />
        </div>
        <p className="text-xs text-muted">
          The customer sees this exact component. Sponsored campaigns show the
          badge automatically.
        </p>
      </aside>
    </div>
  );
}
