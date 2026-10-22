"use client";

import { useActionState, useRef, useState } from "react";
import { Play, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/field";
import { cn } from "@/lib/utils/cn";
import { ALERT_PRESETS, playAlertSound } from "@/lib/alerts/tones";
import { POD_PHOTO_RULES } from "@/lib/settings-defaults";
import { saveSettingsAction, type ActionResult } from "./actions";
import type { PlatformSettings, PodPhotoRule } from "@/types";

const POD_PHOTO_RULE_LABELS: Record<PodPhotoRule, string> = {
  never: "Never",
  cod: "Cash orders only",
  always: "Every delivery",
  exceptions: "Ops-approved completions only",
};

/**
 * Platform configuration, as the console's settings grid: cards that group
 * related rules, each row a label, a hint and the control that changes it.
 *
 * Still one plain `<form>` with one submit. The switches are real checkboxes
 * (see `.c-switch` in globals.css) rather than client-state toggles, so nothing
 * here holds a copy of the settings that could drift from the server's, and the
 * whole screen works before hydration. The design's "persist on change" was not
 * adopted deliberately: these values bill every order on the platform, and a
 * fee that saves the instant a finger brushes it is not a setting, it is an
 * accident.
 */

const rowCls =
  "flex items-center justify-between gap-3 border-t border-[color:var(--c-divider)] py-[11px] first:border-t-0";

function Card({
  title,
  desc,
  children,
  className,
}: Readonly<{
  title: string;
  desc?: string;
  children: React.ReactNode;
  className?: string;
}>) {
  return (
    <section
      className={cn(
        "flex h-full flex-col rounded-xl border border-line bg-surface px-[17px] py-4",
        className
      )}
    >
      <h2 className="text-[14.5px] font-bold tracking-[-0.01em]">{title}</h2>
      {desc ? <p className="mt-0.5 text-xs text-muted">{desc}</p> : null}
      <div className="mt-2.5 flex-1">{children}</div>
    </section>
  );
}

/** Label + hint on the left, control on the right. */
function Row({
  label,
  hint,
  children,
  htmlFor,
}: Readonly<{
  label: string;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}>) {
  return (
    <div className={rowCls}>
      <label htmlFor={htmlFor} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[12.5px] font-semibold text-ink">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
            {hint}
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

/**
 * A closing note under a card's rows. Carries the same top hairline the rows
 * use so it reads as part of the stack rather than as text floating under it,
 * which is what a bare <p> looked like next to the neighbouring cards.
 */
function Note({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p className="border-t border-[color:var(--c-divider)] pt-[11px] text-[11.5px] leading-relaxed text-muted">
      {children}
    </p>
  );
}

/** A full-width field, for values a 96px box cannot hold. */
function Stacked({
  label,
  hint,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}>) {
  return (
    <label className="block border-t border-[color:var(--c-divider)] py-[11px] first:border-t-0">
      <span className="block text-[12.5px] font-semibold text-ink">{label}</span>
      {hint ? (
        <span className="mt-0.5 block text-[11.5px] text-muted">{hint}</span>
      ) : null}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

function Num({
  name,
  defaultValue,
  min = 0,
  max,
  step,
  id,
  disabled,
}: Readonly<{
  name: string;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  id: string;
  disabled?: boolean;
}>) {
  return (
    <input
      id={id}
      type="number"
      name={name}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      // Every one of these fields is pre-filled, usually with 0. Clicking into
      // one drops the caret wherever the pointer landed — typically before the
      // existing digit — so typing "10" over a "0" produced "100". Selecting on
      // focus makes the first keystroke replace the value, which is what
      // "change the number" means on a single-value field like this.
      onFocus={(e) => e.currentTarget.select()}
      className="c-field text-data tabular-nums"
    />
  );
}

/**
 * One app's release track. Both apps take the same four fields, and the pair of
 * version codes only means anything read together, so they are rendered from
 * one component rather than eight hand-written rows that could drift apart.
 *
 * `min` carries `max={latest}` purely as a hint to the number spinner — the
 * form is a public HTTP endpoint, so the real clamp is in `actions.ts` and the
 * 0045 CHECK constraint behind it.
 */
function AppRelease({
  app,
  label,
  latest,
  min,
  url,
  notes,
}: Readonly<{
  app: "rider" | "customer";
  label: string;
  latest: number;
  min: number;
  url: string;
  notes: string;
}>) {
  const key = (field: string) => `${app}Apk${field}`;
  return (
    <>
      <div className="border-t border-[color:var(--c-divider)] pt-[11px] first:border-t-0">
        <span className="block text-[12.5px] font-bold text-ink">{label}</span>
      </div>
      <Row
        label="Latest version code"
        hint="The versionCode of the newest APK you have published."
        htmlFor={key("VersionCode")}
      >
        <Num
          id={key("VersionCode")}
          name={key("VersionCode")}
          defaultValue={latest}
          min={1}
        />
      </Row>
      <Row
        label="Minimum supported"
        hint="Anything below this is forced to update. Cannot exceed the latest."
        htmlFor={key("MinVersionCode")}
      >
        <Num
          id={key("MinVersionCode")}
          name={key("MinVersionCode")}
          defaultValue={min}
          min={1}
          max={latest}
        />
      </Row>
      <Stacked
        label="APK download URL"
        hint="Where the app sends people to update. Must be https — an http link is dropped on save, because anything on the network could swap the file being installed."
      >
        <input
          name={key("Url")}
          defaultValue={url}
          type="url"
          className="c-field c-field-wide"
          placeholder="https://.../rider-v45.apk"
        />
      </Stacked>
      <Stacked label="Release notes" hint="Shown in the update prompt.">
        <textarea
          name={key("Notes")}
          defaultValue={notes}
          rows={2}
          className="c-field c-field-wide resize-y"
        />
      </Stacked>
    </>
  );
}

/** What a refused alert-sound upload says, by the API's error code. */
function uploadErrorText(error: string | undefined): string {
  if (error === "too_large") return "That file is too large — 3 MB max.";
  if (error === "invalid_type") return "Use an MP3, WAV or OGG file.";
  return "Couldn't upload that file.";
}

/**
 * One role's alert sound: a preset picker plus an optional custom upload,
 * with a Test button that plays whichever is currently active. Fields carry
 * their state into the surrounding `<form>` as ordinary named/hidden inputs —
 * `saveSettingsAction`'s `parse()` reads them the same way as everything
 * else, and treats a MISSING `*Url`/`*Name` pair (not an empty one) as
 * "remove the custom sound" (see actions.ts).
 */
function AlertSoundRow({
  role,
  presetName,
  presetDefault,
  urlName,
  urlDefault,
  nameName,
  nameDefault,
}: Readonly<{
  role: string;
  presetName: string;
  presetDefault: string;
  urlName: string;
  urlDefault: string | null;
  nameName: string;
  nameDefault: string | null;
}>) {
  const [presetValue, setPresetValue] = useState(presetDefault);
  const [custom, setCustom] = useState<{ url: string; name: string } | null>(
    urlDefault ? { url: urlDefault, name: nameDefault ?? urlDefault } : null
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const test = () => {
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      void ctx.resume().then(() => playAlertSound(ctx, presetValue, custom?.url));
    } catch {
      setError("This browser wouldn't play the sound.");
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/alert-sounds", {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; url: string; name: string }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        setError(uploadErrorText(body && "error" in body ? body.error : undefined));
        return;
      }
      setCustom({ url: body.url, name: body.name });
    } catch {
      setError("Couldn't upload that file.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className={rowCls + " flex-col items-stretch gap-2"}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] font-semibold text-ink">{role}</span>
        <div className="flex items-center gap-1.5">
          <select
            name={presetName}
            value={presetValue}
            onChange={(e) => setPresetValue(e.target.value)}
            disabled={Boolean(custom)}
            className="c-field text-[12.5px] disabled:opacity-50"
          >
            {ALERT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="outline" onClick={test}>
            <Play className="size-3.5" /> Test
          </Button>
        </div>
      </div>

      {custom ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">
            Custom: {custom.name}
          </span>
          <input type="hidden" name={urlName} value={custom.url} />
          <input type="hidden" name={nameName} value={custom.name} />
          <button
            type="button"
            onClick={() => setCustom(null)}
            className="press grid size-6 shrink-0 place-items-center rounded-full text-muted hover:text-deal"
            aria-label={`Remove the custom ${role.toLowerCase()} sound`}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/mpeg,audio/wav,audio/ogg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="press inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent-ink disabled:opacity-50"
          >
            <Upload className="size-3.5" />
            {uploading ? "Uploading…" : "Upload a custom sound"}
          </button>
        </div>
      )}
      {error ? <p className="text-[11.5px] text-deal">{error}</p> : null}
    </div>
  );
}

/** Which vendors the platform commission reaches, under the commission fields. */
function CommissionCoverageText({
  coverage,
}: Readonly<{
  coverage: { inheriting: number; overridden: number; migrated: boolean };
}>) {
  if (!coverage.migrated) {
    return (
      <>
        Not stored yet — apply migration{" "}
        <code className="rounded bg-surface-2 px-1">0032_platform_commission.sql</code>{" "}
        to save a platform rate. Until then each vendor keeps its own commission.
      </>
    );
  }
  if (coverage.overridden > 0) {
    return (
      <>
        Applies to {coverage.inheriting} of {coverage.inheriting + coverage.overridden}{" "}
        vendors — the other {coverage.overridden} have a negotiated rate and won&apos;t
        change. Settlements already generated keep the rate they were created with.
      </>
    );
  }
  return (
    <>
      Applies to all {coverage.inheriting} vendors. Settlements already generated keep the
      rate they were created with. To exempt one vendor, set a commission on their own page.
    </>
  );
}

export function SettingsForm({
  settings,
  razorpayConfigured = false,
  vendorCommissionPct = 0,
  commissionGstPct = 0,
  commissionCoverage = { inheriting: 0, overridden: 0, migrated: true },
  rateCardReady = true,
  cashLimitsReady = true,
}: Readonly<{
  settings: PlatformSettings;
  /** Are the Razorpay keys present in this environment? */
  razorpayConfigured?: boolean;
  /**
   * Passed separately from `settings` on purpose: `PlatformSettings` is
   * client-safe and shared with the cart, and what the platform charges its
   * vendors is not storefront config. See `admin-commission.ts`.
   */
  vendorCommissionPct?: number;
  /** GST charged on that commission — the second deduction on a payout. */
  commissionGstPct?: number;
  /** How many vendors track the platform rate vs hold their own. */
  commissionCoverage?: {
    inheriting: number;
    overridden: number;
    /** False until migration 0032 is applied. */
    migrated: boolean;
  };
  /**
   * False until migration 0083 adds the rider rate-card columns. The card then
   * says so and its four fields are disabled: saving them would otherwise
   * succeed and change nothing, which looks exactly like it worked.
   */
  rateCardReady?: boolean;
  cashLimitsReady?: boolean;
}>) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    saveSettingsAction,
    { ok: false }
  );

  return (
    <form action={formAction} className="space-y-4 pb-24 @3xl:pb-0">
      {state.error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="rounded-xl border border-green/30 bg-green/10 px-3.5 py-3 text-sm font-medium text-green">
          Settings saved. The app now bills and behaves from these values.
        </p>
      ) : null}

      <div className="grid grid-cols-1 items-stretch gap-3.5 @3xl:grid-cols-2">
        <Card
          className="@3xl:order-1"
          title="Vendor commission"
          desc="What the platform keeps from each vendor's food subtotal. Settlements are generated from it."
        >
          <Row
            label="Commission"
            hint="Percent of the food subtotal."
            htmlFor="vendorCommissionPct"
          >
            <Num
              id="vendorCommissionPct"
              name="vendorCommissionPct"
              defaultValue={vendorCommissionPct}
              max={100}
              step={0.5}
            />
          </Row>
          <Row
            label="GST on commission"
            hint="Percent of the commission, not of the food. 18 in India."
            htmlFor="commissionGstPct"
          >
            <Num
              id="commissionGstPct"
              name="commissionGstPct"
              defaultValue={commissionGstPct}
              max={100}
              step={0.5}
            />
          </Row>
          <Note>
            <CommissionCoverageText coverage={commissionCoverage} />
          </Note>
        </Card>

        <Card
          className="@3xl:order-2"
          title="Fees and tax"
          desc="Authoritative — every order is billed from these, free delivery and minimums included."
        >
          <Row label="Delivery fee" hint="In rupees, per order." htmlFor="deliveryFee">
            <Num id="deliveryFee" name="deliveryFee" defaultValue={settings.deliveryFee} />
          </Row>
          <Row label="Tax" hint="Percent, applied to the item subtotal only." htmlFor="taxRatePct">
            <Num
              id="taxRatePct"
              name="taxRatePct"
              defaultValue={+(settings.taxRate * 100).toFixed(2)}
              max={100}
              step={0.5}
            />
          </Row>
          <Row
            label="Free delivery over"
            hint="0 means delivery is never free."
            htmlFor="freeDeliveryThreshold"
          >
            <Num
              id="freeDeliveryThreshold"
              name="freeDeliveryThreshold"
              defaultValue={settings.freeDeliveryThreshold}
            />
          </Row>
          <Row label="Minimum order" hint="0 means no minimum." htmlFor="minOrder">
            <Num id="minOrder" name="minOrder" defaultValue={settings.minOrder} />
          </Row>
        </Card>

        <Card
          className="@3xl:order-3"
          title="Availability"
          desc="Turn the whole platform — or individual verticals — on and off."
        >
          <Row
            label="Accepting orders"
            hint="Master switch. When off, customers can browse but not check out."
            htmlFor="acceptingOrders"
          >
            <Switch
              id="acceptingOrders"
              label="Accepting orders"
              name="acceptingOrders"
              defaultChecked={settings.acceptingOrders}
            />
          </Row>
          {/* These two now gate the Stores tab's category tiles and their heroes
              (lib/store-categories.ts). Until that consumer existed, switching
              one off changed nothing at all while this form confirmed the save.

              The "Pharmacy" switch that sat between them has been removed. There
              is no pharmacy category, hero or vertical anywhere in the product,
              so it could not be wired to anything — and a switch over a feature
              that does not exist is the same dead control in a new place. The
              column stays in the database; nothing presents it as operational.
              Add the switch back with the vertical, not before it. */}
          <Row label="Grocery" hint="Show the grocery category and its WhatsApp ordering hero." htmlFor="featureGrocery">
            <Switch
              id="featureGrocery"
              label="Grocery"
              name="featureGrocery"
              defaultChecked={settings.featureGrocery}
            />
          </Row>
          <Row label="Pick & Drop" hint="Show the courier category and its hero." htmlFor="featurePickDrop">
            <Switch
              id="featurePickDrop"
              label="Pick & Drop"
              name="featurePickDrop"
              defaultChecked={settings.featurePickDrop}
            />
          </Row>
          <Stacked
            label="Maintenance message"
            hint="Shown to customers when set. Leave blank for none."
          >
            <input
              name="maintenanceMessage"
              defaultValue={settings.maintenanceMessage}
              className="c-field c-field-wide"
              placeholder="We're briefly down for maintenance — back soon."
            />
          </Stacked>
        </Card>

        <Card
          className="@3xl:order-5"
          title="Payments"
          desc="Cash on delivery is always available. Online payment is off until you turn it on here."
        >
          <Row
            label="Online payment (Razorpay)"
            hint={
              razorpayConfigured
                ? "UPI, cards, netbanking and wallets at checkout."
                : "Razorpay keys are not set in this environment — customers keep seeing “Available soon” until they are, whether or not this is on."
            }
            htmlFor="featureOnlinePayment"
          >
            <Switch
              id="featureOnlinePayment"
              label="Online payment (Razorpay)"
              name="featureOnlinePayment"
              defaultChecked={settings.featureOnlinePayment}
            />
          </Row>
          {!razorpayConfigured ? (
            <p className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted">
              Set <code className="rounded bg-surface px-1">RAZORPAY_KEY_ID</code>,{" "}
              <code className="rounded bg-surface px-1">RAZORPAY_KEY_SECRET</code>{" "}
              and{" "}
              <code className="rounded bg-surface px-1">
                RAZORPAY_WEBHOOK_SECRET
              </code>{" "}
              (plus{" "}
              <code className="rounded bg-surface px-1">
                NEXT_PUBLIC_RAZORPAY_KEY_ID
              </code>{" "}
              for the browser checkout), then point a Razorpay webhook at{" "}
              <code className="rounded bg-surface px-1">
                /api/payments/razorpay/webhook
              </code>
              . Migration{" "}
              <code className="rounded bg-surface px-1">
                0025_payments_razorpay.sql
              </code>{" "}
              must be applied too.
            </p>
          ) : null}
        </Card>

        <Card
          className="@3xl:order-6"
          title="Dispatch"
          desc="Operational defaults for routing and prep time."
        >
          <Row label="Default prep time" hint="Minutes, when a shop has not set its own." htmlFor="defaultPrepMinutes">
            <Num
              id="defaultPrepMinutes"
              name="defaultPrepMinutes"
              defaultValue={settings.defaultPrepMinutes}
            />
          </Row>
          <Row label="Delivery radius" hint="Kilometres from Bemetara city centre — one circle for the whole city. 0 switches the limit off." htmlFor="deliveryRadiusKm">
            <Num
              id="deliveryRadiusKm"
              name="deliveryRadiusKm"
              defaultValue={settings.deliveryRadiusKm}
              step={0.5}
            />
          </Row>
        </Card>

        <Card
          className="@3xl:order-6"
          title="Riders"
          desc="How long a rider has to take an offer, when a delivery needs a photo, where routes come from, and what a delivery pays the rider. Leave every rate at 0 for a salaried fleet; a rate change affects later deliveries only."
        >
          <Row
            label="Offer window"
            hint="Seconds a rider has to accept an offer before it goes to the next rider. 60 to 600."
            htmlFor="riderOfferWindowSeconds"
          >
            <Num
              id="riderOfferWindowSeconds"
              name="riderOfferWindowSeconds"
              defaultValue={settings.riderOfferWindowSeconds}
              min={60}
              max={600}
              step={10}
            />
          </Row>
          <Row
            label="Proof-of-delivery photo"
            hint="When the rider must photograph the package at the door."
            htmlFor="podPhotoRule"
          >
            <select
              id="podPhotoRule"
              name="podPhotoRule"
              defaultValue={settings.podPhotoRule}
              className="c-field text-[12.5px]"
            >
              {POD_PHOTO_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {POD_PHOTO_RULE_LABELS[rule]}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Unreachable wait"
            hint="Minutes at the door, after calling the customer, before a rider can report them unreachable. 3 to 30."
            htmlFor="unreachableWaitMinutes"
          >
            <Num
              id="unreachableWaitMinutes"
              name="unreachableWaitMinutes"
              defaultValue={settings.unreachableWaitMinutes}
              min={3}
              max={30}
            />
          </Row>
          <Stacked
            label="Routing server"
            hint="OSRM-compatible server for route distance and the rider's map. Must be https — anything else keeps the current server."
          >
            <input
              name="routingBaseUrl"
              defaultValue={settings.routingBaseUrl}
              type="url"
              required
              className="c-field c-field-wide"
              placeholder="https://router.project-osrm.org"
            />
          </Stacked>
          {/* The rate card (0083). The database applies it when a delivery
              becomes delivered, so a change reaches later deliveries only. */}
          {rateCardReady ? null : (
            <p
              role="status"
              className="rounded-lg border border-pop/40 bg-pop/10 px-3 py-2 text-[12px] font-medium leading-snug text-ink"
            >
              Rider pay rates need migration 0083 — saving them does nothing yet.
            </p>
          )}
          <Row label="Base fee" hint="Rupees per delivered delivery." htmlFor="riderBaseFee">
            <Num
              id="riderBaseFee"
              name="riderBaseFee"
              disabled={!rateCardReady}
              defaultValue={settings.riderRateCard.baseFee}
              step={0.01}
            />
          </Row>
          <Row
            label="Kilometres included"
            hint="Distance the base fee covers (shop to customer, by road)."
            htmlFor="riderKmIncluded"
          >
            <Num
              id="riderKmIncluded"
              name="riderKmIncluded"
              disabled={!rateCardReady}
              defaultValue={settings.riderRateCard.kmIncluded}
              step={0.01}
            />
          </Row>
          <Row label="Per extra kilometre" hint="Rupees for each km beyond those included." htmlFor="riderPerKm">
            <Num
              id="riderPerKm"
              name="riderPerKm"
              disabled={!rateCardReady}
              defaultValue={settings.riderRateCard.perKm}
              step={0.01}
            />
          </Row>
          <Row
            label="Minimum per delivery"
            hint="The least a delivery pays before tips. An online tip is added on top; a cash tip stays with the rider."
            htmlFor="riderMinPerDelivery"
          >
            <Num
              id="riderMinPerDelivery"
              name="riderMinPerDelivery"
              disabled={!rateCardReady}
              defaultValue={settings.riderRateCard.minPerDelivery}
              step={0.01}
            />
          </Row>
          {/* Cash riders collect for Deligro (0085). Not their pay: the Cash
              screen turns red and a reminder is pushed past either limit. */}
          {cashLimitsReady ? null : (
            <p
              role="status"
              className="rounded-lg border border-pop/40 bg-pop/10 px-3 py-2 text-[12px] font-medium leading-snug text-ink"
            >
              Rider cash limits need migration 0085 — saving them does nothing yet.
            </p>
          )}
          <Row
            label="Cash limit"
            hint="Rupees of cash a rider may hold before they are told to deposit. 0 to 100,000; 0 turns it off."
            htmlFor="riderCashLimit"
          >
            <Num
              id="riderCashLimit"
              name="riderCashLimit"
              disabled={!cashLimitsReady}
              defaultValue={settings.riderCashLimit}
              min={0}
              max={100000}
            />
          </Row>
          <Row
            label="Cash held for"
            hint="Hours the oldest undeposited cash may stay with a rider. 0 to 720; 0 turns it off."
            htmlFor="riderCashMaxHours"
          >
            <Num
              id="riderCashMaxHours"
              name="riderCashMaxHours"
              disabled={!cashLimitsReady}
              defaultValue={settings.riderCashMaxHours}
              min={0}
              max={720}
            />
          </Row>
        </Card>

        <Card
          className="@3xl:order-7"
          title="Alert sounds"
          desc="What plays when a new order arrives — one sound per role, for every vendor and every rider."
        >
          <AlertSoundRow
            role="Vendor kitchen board"
            presetName="vendorAlertSoundPreset"
            presetDefault={settings.vendorAlertSoundPreset}
            urlName="vendorAlertSoundUrl"
            urlDefault={settings.vendorAlertSoundUrl}
            nameName="vendorAlertSoundName"
            nameDefault={settings.vendorAlertSoundName}
          />
          <AlertSoundRow
            role="Rider board"
            presetName="riderAlertSoundPreset"
            presetDefault={settings.riderAlertSoundPreset}
            urlName="riderAlertSoundUrl"
            urlDefault={settings.riderAlertSoundUrl}
            nameName="riderAlertSoundName"
            nameDefault={settings.riderAlertSoundName}
          />
          <Note>
            Custom uploads take over from the preset for that role. Remove one
            to fall back to the preset. MP3, WAV or OGG, 3 MB max.
          </Note>
        </Card>

        <Card
          className="@3xl:order-4"
          title="Reviews"
          desc="How long a customer has to review an order, and to change their mind afterwards. Both are enforced by the database, not just the app."
        >
          <Row
            label="Review window"
            hint="Days after delivery that an order can still be reviewed."
            htmlFor="reviewWindowDays"
          >
            <Num
              id="reviewWindowDays"
              name="reviewWindowDays"
              defaultValue={settings.reviewWindowDays}
              min={1}
              max={365}
            />
          </Row>
          <Row
            label="Edit window"
            hint="Hours after posting that a customer can edit or withdraw their review. 0 locks it immediately."
            htmlFor="reviewEditWindowHours"
          >
            <Num
              id="reviewEditWindowHours"
              name="reviewEditWindowHours"
              defaultValue={settings.reviewEditWindowHours}
              min={0}
              max={720}
            />
          </Row>
          <Note>
            Changing these takes effect immediately, for reviews already posted as
            well as new ones — shortening the edit window can lock a review a
            customer was part-way through changing.
          </Note>
        </Card>

        <Card
          className="@3xl:order-4"
          title="Support and brand"
          desc="Shown to customers on the Help and Profile screens."
        >
          <Stacked label="Business name">
            <input
              name="businessName"
              defaultValue={settings.businessName}
              className="c-field c-field-wide"
            />
          </Stacked>
          <Stacked label="Support phone">
            <input
              name="supportPhone"
              defaultValue={settings.supportPhone}
              className="c-field c-field-wide"
              placeholder="+91 98765 43210"
            />
          </Stacked>
          <Stacked label="Support WhatsApp">
            <input
              name="supportWhatsapp"
              defaultValue={settings.supportWhatsapp}
              className="c-field c-field-wide"
              placeholder="+91 98765 43210"
            />
          </Stacked>
          <Stacked label="Support email">
            <input
              type="email"
              name="supportEmail"
              defaultValue={settings.supportEmail}
              className="c-field c-field-wide"
              placeholder="help@deligro.in"
            />
          </Stacked>
          <Stacked label="Business address">
            <textarea
              name="businessAddress"
              defaultValue={settings.businessAddress}
              rows={2}
              className="c-field c-field-wide resize-y"
            />
          </Stacked>
          <Stacked
            label="Privacy policy URL"
            hint="Linked from the apps once set. Leave empty until a policy is published. Must be https — an http link is dropped on save."
          >
            <input
              name="privacyPolicyUrl"
              defaultValue={settings.privacyPolicyUrl}
              type="url"
              className="c-field c-field-wide"
              placeholder="https://.../privacy"
            />
          </Stacked>
          <Stacked
            label="Terms of service URL"
            hint="Linked from the apps once set. Leave empty until terms are published. Must be https."
          >
            <input
              name="termsUrl"
              defaultValue={settings.termsUrl}
              type="url"
              className="c-field c-field-wide"
              placeholder="https://.../terms"
            />
          </Stacked>
        </Card>

        <Card
          className="@3xl:order-7 @3xl:col-span-2"
          title="App releases"
          desc="What the rider and customer Android apps are told when they check for an update. There is no Play Store behind these — the apps install from the APK link you put here."
        >
          <div className="grid grid-cols-1 gap-x-6 @3xl:grid-cols-2">
            <div>
              <AppRelease
                app="rider"
                label="Rider app"
                latest={settings.riderApkVersionCode}
                min={settings.riderApkMinVersionCode}
                url={settings.riderApkUrl}
                notes={settings.riderApkNotes}
              />
            </div>
            <div>
              <AppRelease
                app="customer"
                label="Customer app"
                latest={settings.customerApkVersionCode}
                min={settings.customerApkMinVersionCode}
                url={settings.customerApkUrl}
                notes={settings.customerApkNotes}
              />
            </div>
          </div>
          <Note>
            Raising the minimum takes effect on the next check every installed
            app makes, and there is no way to undo it for someone already
            blocked — they can only go forwards, to the APK at the URL above.
            Publish the file first, then raise the numbers.
          </Note>
        </Card>
      </div>

      <div className="action-dock flex items-center gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur @3xl:mt-1 @3xl:justify-end">
        <Button
          type="submit"
          disabled={pending}
          className="@3xl:hidden"
        >
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <button
          type="submit"
          disabled={pending}
          className="c-btn c-btn-dark press hidden disabled:opacity-50 @3xl:inline-flex"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        <p className="text-xs text-muted">
          Nothing is saved until you press this.
        </p>
      </div>
    </form>
  );
}
