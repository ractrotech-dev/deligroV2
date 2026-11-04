"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { fieldCls, labelCls } from "@/components/ui/field";
import { PromoBannerCarousel } from "@/components/home/promo-banner-carousel";
import { saveBannerAction, type ActionResult } from "./actions";
import { LIVE_PLACEMENTS, LIVE_TARGETS, PLACEMENT_LABEL, bannerShowsAnywhere, isLiveTarget } from "@/lib/banner-placements";
import { isoToIstLocal } from "@/lib/utils/ist-time";
import type { Banner, BannerKind, BannerStatus, BannerTargetType } from "@/types";

// Was a local copy of the same two strings. Sharing them is what lets the
// console restyle every form at once — a private copy here would have left this
// screen's inputs at mobile proportions inside the console.
const field = fieldCls;

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
  // An old banner may hold a link type that goes nowhere. It opens on a working
  // one, with a line saying so, rather than showing a choice we no longer offer.
  const savedTarget = banner?.target.type;
  const deadTarget = savedTarget && !isLiveTarget(savedTarget) ? savedTarget : null;
  const [targetType, setTargetType] = useState<BannerTargetType>(
    savedTarget && !deadTarget ? savedTarget : "food"
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

  const target = LIVE_TARGETS.find((t) => t.id === targetType);
  const notShowing = Boolean(banner) && !bannerShowsAnywhere(banner?.placements);

  const submitLabel = editing ? "Save changes" : "Create campaign";

  return (
    <div className="grid gap-6 grid-cols-[1fr_360px]">
      <form action={formAction} className="space-y-6">
        {state.error ? (
          <p className="rounded-[var(--c-r)] border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
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
                {LIVE_TARGETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Labeled>
            {target?.needsValue ? (
              <Labeled label="Leads to (required)" hint={target.hint}>
                <input
                  name="targetValue"
                  defaultValue={deadTarget ? undefined : banner?.target.value}
                  className={field}
                />
              </Labeled>
            ) : null}
          </div>
          {deadTarget ? (
            <p className="text-xs font-medium text-deal">
              This banner&apos;s old link goes nowhere. Pick where it should lead.
            </p>
          ) : null}
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-heading text-[15px]">Placement &amp; order</h2>
          <div className="space-y-1.5">
            <span className={labelCls}>Show on</span>
            <div className="grid grid-cols-2 gap-2">
              {LIVE_PLACEMENTS.map((p) => (
                <label
                  key={p}
                  className="flex items-center gap-2 rounded-[var(--c-r)] bg-surface-2 px-3 py-2.5 text-sm font-medium"
                >
                  <input
                    type="checkbox"
                    name={`placement:${p}`}
                    // A new banner, or one showing nowhere, starts on the one
                    // place that works. Saving is what fixes it.
                    defaultChecked={!banner || notShowing || banner.placements.includes(p)}
                    className="size-4 accent-accent"
                  />
                  {PLACEMENT_LABEL[p] ?? p}
                </label>
              ))}
            </div>
            {notShowing ? (
              <p className="text-xs font-medium text-deal">
                Not showing anywhere right now. Save to put it on the home page.
              </p>
            ) : null}
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
          <h2 className="text-heading text-[15px]">Schedule</h2>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Starts (India time)">
              <input
                type="datetime-local"
                name="startsAt"
                defaultValue={isoToIstLocal(banner?.startsAt)}
                className={field}
              />
            </Labeled>
            <Labeled label="Ends (India time)">
              <input
                type="datetime-local"
                name="endsAt"
                defaultValue={isoToIstLocal(banner?.endsAt)}
                className={field}
              />
            </Labeled>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
          <Link href="/admin/banners">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
        </div>
      </form>

      <aside className="space-y-3 sticky top-24 self-start">
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
