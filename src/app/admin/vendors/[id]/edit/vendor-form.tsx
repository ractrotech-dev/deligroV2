"use client";

import { useActionState, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Field, Switch, fieldCls, labelCls } from "@/components/ui/field";
import { MapPicker } from "@/components/location/map-picker";
import { GoogleShopSearch } from "@/components/admin/google-shop-search";
import { ShopPhotoUpload } from "@/components/admin/shop-photo-upload";
import { isMapsConfigured } from "@/lib/maps/config";
import { cn } from "@/lib/utils/cn";
import {
  CYCLE_LABEL,
  CYCLE_NOTE,
  SETTLEMENT_CYCLES,
  type SettlementCycle,
} from "@/lib/settlements/cycle";
import { saveVendorAction, saveVendorLocationAction, type ActionResult } from "../../actions";
import type { VendorDetail } from "@/lib/data-access/admin-vendors";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function time(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

/** "14:30" → "2:30 pm". */
function clock(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** The hours as the form stands, in one line, so nobody has to read the controls back. */
function hoursSummary(opens: string, closes: string, off: string[]): string {
  const hours = opens && closes ? `${clock(opens)} to ${clock(closes)}` : "No hours set";
  if (off.length === 0) return `${hours}, every day`;
  if (off.length === DAYS.length) return "Closed every day";
  const days = DAYS.filter((d) => off.includes(d)).map((d) => d.slice(0, 3));
  return `${hours}, closed ${days.join(", ")}`;
}

/** What the cash ceiling will do, under its field, as the form stands. */
function codLimitNote(acceptCod: boolean, codLimit: number): string {
  if (!acceptCod) return "Cash on delivery is off, so this limit does nothing.";
  if (codLimit > 0) {
    return `Customers will see: “Orders above ₹${codLimit.toLocaleString("en-IN")} must be paid online.”`;
  }
  return "A cash limit of 0 uses the platform limit. If both are set, the stricter applies.";
}

/**
 * One section: what it is on the left, its fields on a 12-column grid on the right.
 * Every section shares the two columns and the grid, so fields line up down the page.
 */
function Group({
  id,
  title,
  description,
  aside,
  children,
}: Readonly<{
  id?: string;
  title: string;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}>) {
  return (
    <section
      id={id}
      className="grid scroll-mt-24 grid-cols-[210px_minmax(0,1fr)] gap-x-8 border-t border-[color:var(--c-divider)] py-5 first:border-t-0"
    >
      <div className="space-y-2.5">
        <div>
          <h2 className="text-[13.5px] font-semibold leading-4 text-ink">{title}</h2>
          {description ? <p className="mt-1 text-[12px] leading-relaxed text-muted">{description}</p> : null}
        </div>
        {aside}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

const GRID = "grid grid-cols-12 gap-x-3 gap-y-3.5";

/** A field holding a unit, such as rupees or percent. */
function Unit({
  before,
  after,
  ...input
}: Readonly<{ before?: string; after?: string } & React.InputHTMLAttributes<HTMLInputElement>>) {
  return (
    <span className="c-affix">
      {before ? <span>{before}</span> : null}
      <input {...input} />
      {after ? <span>{after}</span> : null}
    </span>
  );
}

function Option({
  name,
  label,
  defaultChecked,
  onChange,
}: Readonly<{
  name: string;
  label: string;
  defaultChecked: boolean;
  onChange?: (on: boolean) => void;
}>) {
  return (
    <label className="c-option">
      {label}
      <Switch name={name} defaultChecked={defaultChecked} onChange={onChange} />
    </label>
  );
}

function Note({ children, tone }: Readonly<{ children: React.ReactNode; tone?: "red" }>) {
  return (
    <p className={cn("col-span-12 text-[12px] leading-relaxed", tone === "red" ? "font-medium text-deal" : "text-muted")}>
      {children}
    </p>
  );
}

/**
 * Edit a vendor's business fields, on one wide page with one Save. Mostly
 * uncontrolled inputs with defaultValue: the server action reads FormData and
 * re-validates. Status and slug are managed elsewhere (row actions / wizard), and the
 * login is on the shop's Access tab.
 *
 * The Location section also has its own button, because moving a pin is often the
 * only thing someone came to do. It saves those fields alone.
 */
export function VendorForm({
  vendor,
  categories,
  platformCommissionPct = 0,
  areas,
}: Readonly<{
  vendor: VendorDetail;
  categories: string[];
  /** Delivery zones a shop can be placed in. Empty on a database without zones. */
  areas: { id: string; label: string }[];
  /** Shown as the placeholder when this vendor has no override of its own. */
  platformCommissionPct?: number;
}>) {
  const action = saveVendorAction.bind(null, vendor.id);
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    action,
    { ok: false }
  );

  const categoryOptions = categories.includes(vendor.category ?? "")
    ? categories
    : [...(vendor.category ? [vendor.category] : []), ...categories];

  // These parts explain themselves as they are edited, which needs live state; the
  // rest of the form stays uncontrolled and is read from FormData by the action.
  const [acceptCod, setAcceptCod] = useState(vendor.acceptCod);
  const [acceptOnline, setAcceptOnline] = useState(vendor.acceptOnline);
  const [codLimit, setCodLimit] = useState(vendor.codMaxOrder);
  const [cycle, setCycle] = useState<SettlementCycle>(vendor.settlementCycle);
  const [opens, setOpens] = useState(time(vendor.openingTime));
  const [closes, setCloses] = useState(time(vendor.closingTime));
  const [weeklyOff, setWeeklyOff] = useState<string[]>(vendor.weeklyOff);

  // The pin and photo are set by widgets, so they are state with a form field each.
  const [imageUrl, setImageUrl] = useState<string | null>(vendor.imageUrl);
  const [moveTo, setMoveTo] = useState<{ lat: number; lng: number } | null>(null);
  const initialPin = vendor.lat !== null && vendor.lng !== null ? { lat: vendor.lat, lng: vendor.lng } : null;

  const [place, setPlace] = useState({
    zoneId: vendor.zoneId ?? "",
    address: vendor.address ?? "",
    landmark: vendor.landmark ?? "",
    pincode: vendor.pincode ?? "",
    lat: vendor.lat === null ? "" : String(vendor.lat),
    lng: vendor.lng === null ? "" : String(vendor.lng),
  });
  const [savedPlace, setSavedPlace] = useState(place);
  const [savingPlace, startSavingPlace] = useTransition();
  const [placeError, setPlaceError] = useState<string | null>(null);
  const router = useRouter();
  const placeChanged = (Object.keys(place) as (keyof typeof place)[]).some((k) => place[k] !== savedPlace[k]);
  const edit = (patch: Partial<typeof place>) => setPlace((p) => ({ ...p, ...patch }));

  const saveLocation = () => {
    setPlaceError(null);
    startSavingPlace(async () => {
      const res = await saveVendorLocationAction(vendor.id, place);
      if (!res.ok) {
        setPlaceError(res.error ?? "Couldn't save the location. Try again.");
        return;
      }
      setSavedPlace(place);
      router.refresh();
    });
  };

  return (
    <form action={formAction} className="c-form">
      <Group title="Shop" description="What customers see.">
        <div className="flex gap-5">
          <div id="photo" className="shrink-0 scroll-mt-24">
            <ShopPhotoUpload tile value={imageUrl} onChange={setImageUrl} />
            <input type="hidden" name="imageUrl" value={imageUrl ?? ""} />
          </div>
          <div className={cn(GRID, "min-w-0 flex-1")}>
            <div className="col-span-5">
              <Field label="Shop name" required>
                <input name="name" defaultValue={vendor.name} className={fieldCls} required />
              </Field>
            </div>
            <div className="col-span-3">
              <Field label="Category">
                <select name="category" defaultValue={vendor.category ?? ""} className={fieldCls}>
                  <option value="">Uncategorised</option>
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="col-span-4">
              <Field label="Tagline">
                <input name="tagline" defaultValue={vendor.tagline ?? ""} className={fieldCls} />
              </Field>
            </div>
            <div className="col-span-12">
              <Field label="Description">
                <textarea name="description" defaultValue={vendor.description ?? ""} rows={2} className={fieldCls} />
              </Field>
            </div>
          </div>
        </div>
      </Group>

      <Group
        title="Owner & contact"
        description="For reaching the owner. Changing these does not change how they sign in. That is on the shop's Access tab."
      >
        <div className={GRID}>
          <div className="col-span-3">
            <Field label="Owner name">
              <input name="ownerName" defaultValue={vendor.ownerName ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-3">
            <Field label="Contact mobile">
              <input name="ownerMobile" defaultValue={vendor.ownerMobile ?? ""} inputMode="tel" className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-3">
            <Field label="Alt. mobile">
              <input name="ownerAltMobile" defaultValue={vendor.ownerAltMobile ?? ""} inputMode="tel" className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-3">
            <Field label="Contact email" required>
              <input name="ownerEmail" type="email" required defaultValue={vendor.ownerEmail ?? ""} className={fieldCls} />
            </Field>
          </div>
        </div>
      </Group>

      <Group title="Hours & fulfilment" description={hoursSummary(opens, closes, weeklyOff)}>
        <div className={GRID}>
          <div className="col-span-3">
            <Field label="Opens">
              <input type="time" name="openingTime" value={opens} onChange={(e) => setOpens(e.target.value)} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-3">
            <Field label="Closes">
              <input type="time" name="closingTime" value={closes} onChange={(e) => setCloses(e.target.value)} className={fieldCls} />
            </Field>
          </div>
          <div role="group" aria-labelledby="closed-on" className="ui-fieldrow col-span-6 space-y-1.5">
            <span id="closed-on" className={labelCls}>Closed on</span>
            <div className="c-days">
              {DAYS.map((d) => (
                <label key={d} title={d}>
                  <input
                    type="checkbox"
                    name="weeklyOff"
                    value={d}
                    aria-label={d}
                    checked={weeklyOff.includes(d)}
                    onChange={(e) =>
                      setWeeklyOff((off) => (e.target.checked ? [...off, d] : off.filter((x) => x !== d)))
                    }
                    className="sr-only"
                  />
                  <span>{d.slice(0, 3)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="col-span-3">
            <Field label="Min order">
              <Unit before="₹" type="number" name="minOrder" defaultValue={vendor.minOrder} min={0} />
            </Field>
          </div>
          <div className="col-span-3">
            <Field label="Commission">
              <Unit
                after="%"
                type="number"
                name="commissionPct"
                defaultValue={vendor.commissionPct ?? ""}
                placeholder={String(platformCommissionPct)}
                min={0}
                max={100}
                step={0.5}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          </div>
          <div className="col-span-3 self-end">
            <Option name="deliveryAvailable" label="Delivery" defaultChecked={vendor.deliveryAvailable} />
          </div>
          <div className="col-span-3 self-end">
            <Option name="selfPickup" label="Self pickup" defaultChecked={vendor.selfPickup} />
          </div>
          <Note>
            {vendor.commissionPct === null
              ? "Commission follows the platform rate. Type a number to set a rate for this shop only."
              : `Commission overrides the platform rate of ${platformCommissionPct}%. Clear the field to follow it again.`}
          </Note>
        </div>
      </Group>

      <Group
        id="pin"
        title="Location"
        description="New orders go to this area's managers. Orders already placed stay with the old area."
        aside={
          <GoogleShopSearch
            popover
            shopName={vendor.name}
            onUse={(found) => {
              setPlace((p) => ({
                ...p,
                lat: String(found.lat),
                lng: String(found.lng),
                address: found.address || p.address,
                pincode: found.pincode || p.pincode,
              }));
              setMoveTo({ lat: found.lat, lng: found.lng });
            }}
          />
        }
      >
        <div className="grid grid-cols-2 gap-x-5">
          <div className={cn(GRID, "content-start")}>
            <div className="col-span-12">
              <Field label="Address">
                <input name="address" value={place.address} onChange={(e) => edit({ address: e.target.value })} className={fieldCls} />
              </Field>
            </div>
            {areas.length > 0 ? (
              <div className="col-span-6">
                <Field label="Area">
                  <select name="zoneId" value={place.zoneId} onChange={(e) => edit({ zoneId: e.target.value })} className={fieldCls}>
                    {vendor.zoneId ? null : <option value="">Choose an area</option>}
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : null}
            <div className="col-span-6">
              <Field label="Landmark">
                <input name="landmark" value={place.landmark} onChange={(e) => edit({ landmark: e.target.value })} className={fieldCls} />
              </Field>
            </div>
            <div className="col-span-4">
              <Field label="Pincode">
                <input name="pincode" value={place.pincode} onChange={(e) => edit({ pincode: e.target.value })} inputMode="numeric" className={fieldCls} />
              </Field>
            </div>
            <div className="col-span-4">
              <Field label="Latitude">
                <input name="lat" value={place.lat} onChange={(e) => edit({ lat: e.target.value })} inputMode="decimal" placeholder="21.71" className={fieldCls} />
              </Field>
            </div>
            <div className="col-span-4">
              <Field label="Longitude">
                <input name="lng" value={place.lng} onChange={(e) => edit({ lng: e.target.value })} inputMode="decimal" placeholder="81.53" className={fieldCls} />
              </Field>
            </div>
            <div className="col-span-12 flex items-center gap-3 pt-0.5">
              <button
                type="button"
                onClick={saveLocation}
                disabled={!placeChanged || savingPlace}
                className="c-btn c-btn-dark disabled:opacity-50"
              >
                {savingPlace ? "Saving…" : "Save location"}
              </button>
              {placeError ? (
                <p role="alert" className="text-[12px] font-medium text-deal">
                  {placeError}
                </p>
              ) : placeChanged ? (
                <span className="text-[12px] text-muted">Not saved yet.</span>
              ) : savedPlace.lat ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-muted">
                  <Check className="size-3.5 text-green" /> Location saved.
                </span>
              ) : (
                <span className="text-[12px] text-muted">This shop has no pin yet.</span>
              )}
            </div>
          </div>

          {/* A shop with no pin cannot go live or take orders. */}
          <div className="min-h-[260px]">
            {isMapsConfigured ? (
              // The map's search box is not a form field: Enter picks a place there,
              // and must not submit the whole form.
              <div
                className="h-full"
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              >
                <MapPicker
                  variant="panel"
                  initial={initialPin}
                  moveTo={moveTo}
                  reportInitial={!vendor.address}
                  onPick={(loc) => {
                    setPlace((p) => ({
                      ...p,
                      lat: String(loc.lat),
                      lng: String(loc.lng),
                      address: p.address || loc.address,
                    }));
                  }}
                />
              </div>
            ) : (
              <p className="grid h-full place-items-center rounded-[var(--c-r)] border border-dashed border-line px-4 text-center text-[12px] text-muted">
                The map isn&apos;t set up here. Type the latitude and longitude instead.
              </p>
            )}
          </div>
        </div>
      </Group>

      <Group title="Customer payments" description="A method turned off is not shown at checkout.">
        <div className={GRID}>
          <div className="col-span-4 self-end">
            <Option name="acceptCod" label="Cash on delivery" defaultChecked={vendor.acceptCod} onChange={setAcceptCod} />
          </div>
          <div className="col-span-4 self-end">
            <Option name="acceptOnline" label="Online payment" defaultChecked={vendor.acceptOnline} onChange={setAcceptOnline} />
          </div>
          <div className="col-span-4">
            <Field label="Cash limit per order">
              <Unit
                before="₹"
                type="number"
                name="codMaxOrder"
                defaultValue={vendor.codMaxOrder}
                min={0}
                step={10}
                disabled={!acceptCod}
                onChange={(e) => setCodLimit(Number(e.currentTarget.value) || 0)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          </div>
          {!acceptCod && !acceptOnline ? (
            <Note tone="red">Turn on at least one payment method. With both off this shop cannot take any order.</Note>
          ) : (
            <Note>{codLimitNote(acceptCod, codLimit)}</Note>
          )}
        </div>
      </Group>

      <Group title="Settlement" description="How and when this shop is paid.">
        <div className={GRID}>
          <div className="col-span-4">
            <Field label="Pay this shop">
              <select
                name="settlementCycle"
                defaultValue={vendor.settlementCycle}
                className={fieldCls}
                onChange={(e) => setCycle(e.currentTarget.value as SettlementCycle)}
              >
                {SETTLEMENT_CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {CYCLE_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="Other charges per order">
              <Unit
                before="₹"
                type="number"
                name="otherChargesPerOrder"
                defaultValue={vendor.otherChargesPerOrder}
                min={0}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          </div>
          <Note>
            {CYCLE_NOTE[cycle]} Any single order can still be paid early from the order payouts screen.{" "}
            <span className="text-ink">The shop gets food value − commission − GST on commission − other charges.</span>{" "}
            Other charges are a fixed amount per delivered order, such as packaging or gateway fee. Delivery fee, customer
            GST and the rider tip are never part of the shop&apos;s share.
          </Note>
        </div>
      </Group>

      <Group title="Payout account" description="If a UPI ID is set, bank details are optional.">
        <div className={GRID}>
          <div className="col-span-4">
            <Field label="UPI ID">
              <input name="upiId" defaultValue={vendor.upiId ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="Account holder name">
              <input name="bankAccountName" defaultValue={vendor.bankAccountName ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="Bank name">
              <input name="bankName" defaultValue={vendor.bankName ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="IFSC">
              <input name="bankIfsc" defaultValue={vendor.bankIfsc ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="Account number">
              <input name="bankAccountNumber" defaultValue={vendor.bankAccountNumber ?? ""} inputMode="numeric" className={fieldCls} />
            </Field>
          </div>
        </div>
      </Group>

      <Group title="Legal">
        <div className={GRID}>
          <div className="col-span-4">
            <Field label="FSSAI number">
              <input name="fssaiNumber" defaultValue={vendor.fssaiNumber ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="GST number">
              <input name="gstNumber" defaultValue={vendor.gstNumber ?? ""} className={fieldCls} />
            </Field>
          </div>
          <div className="col-span-4">
            <Field label="PAN number">
              <input name="panNumber" defaultValue={vendor.panNumber ?? ""} className={fieldCls} />
            </Field>
          </div>
        </div>
      </Group>

      {/* Stays on screen, so a long form never hides its Save or its error. */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-line bg-bg py-3">
        <button type="submit" disabled={pending} className="c-btn c-btn-dark disabled:opacity-50">
          {pending ? "Saving…" : "Save changes"}
        </button>
        <Link href={`/admin/vendors/${vendor.id}`} className="c-btn c-btn-outline">
          Cancel
        </Link>
        {state.error ? (
          <p role="alert" className="text-[12.5px] font-medium text-deal">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
