"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Section, Toggle, fieldCls, labelCls } from "@/components/ui/field";
import {
  CYCLE_LABEL,
  CYCLE_NOTE,
  SETTLEMENT_CYCLES,
  type SettlementCycle,
} from "@/lib/settlements/cycle";
import { saveVendorAction, type ActionResult } from "../../actions";
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

/**
 * Edit a vendor's business fields. Uncontrolled inputs with defaultValue —
 * the server action reads FormData and re-validates. Status, slug and the login
 * account are managed elsewhere (row actions / wizard), not here.
 */
export function VendorForm({
  vendor,
  categories,
  platformCommissionPct = 0,
}: Readonly<{
  vendor: VendorDetail;
  categories: string[];
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

  // The payment section is the one part of this form that has to explain itself
  // as it is edited — the operator needs to read the exact sentence the
  // customer will see before they save a limit. That needs live state; the rest
  // of the form stays uncontrolled and is read from FormData by the action.
  const [acceptCod, setAcceptCod] = useState(vendor.acceptCod);
  const [acceptOnline, setAcceptOnline] = useState(vendor.acceptOnline);
  const [codLimit, setCodLimit] = useState(vendor.codMaxOrder);
  const [cycle, setCycle] = useState<SettlementCycle>(vendor.settlementCycle);

  return (
    <form action={formAction} className="space-y-4 pb-24">
      {state.error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
          {state.error}
        </p>
      ) : null}

      <Section title="Basic information">
        <Field label="Shop name" required>
          <input name="name" defaultValue={vendor.name} className={fieldCls} required />
        </Field>
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
        <Field label="Tagline">
          <input name="tagline" defaultValue={vendor.tagline ?? ""} className={fieldCls} />
        </Field>
        <Field label="Description">
          <textarea
            name="description"
            defaultValue={vendor.description ?? ""}
            rows={2}
            className={fieldCls}
          />
        </Field>
      </Section>

      <Section title="Owner & contact">
        <Field label="Owner name">
          <input name="ownerName" defaultValue={vendor.ownerName ?? ""} className={fieldCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mobile">
            <input
              name="ownerMobile"
              defaultValue={vendor.ownerMobile ?? ""}
              inputMode="tel"
              className={fieldCls}
            />
          </Field>
          <Field label="Alt. mobile">
            <input
              name="ownerAltMobile"
              defaultValue={vendor.ownerAltMobile ?? ""}
              inputMode="tel"
              className={fieldCls}
            />
          </Field>
        </div>
        <Field
          label="Email"
          required
          hint="The vendor's login is issued against this address. They sign in with their mobile number and password, but without an email there is no account to hold one."
        >
          <input
            name="ownerEmail"
            type="email"
            required
            defaultValue={vendor.ownerEmail ?? ""}
            className={fieldCls}
          />
        </Field>
      </Section>

      <Section title="Hours & fulfilment">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opening time">
            <input
              type="time"
              name="openingTime"
              defaultValue={time(vendor.openingTime)}
              className={fieldCls}
            />
          </Field>
          <Field label="Closing time">
            <input
              type="time"
              name="closingTime"
              defaultValue={time(vendor.closingTime)}
              className={fieldCls}
            />
          </Field>
        </div>
        <div className="space-y-1.5">
          <span className={labelCls}>Weekly off</span>
          <div className="grid grid-cols-2 gap-2">
            {DAYS.map((d) => (
              <label
                key={d}
                className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm font-medium"
              >
                <input
                  type="checkbox"
                  name="weeklyOff"
                  value={d}
                  defaultChecked={vendor.weeklyOff.includes(d)}
                  className="size-4 accent-accent"
                />
                {d}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min order (₹)">
            <input
              type="number"
              name="minOrder"
              defaultValue={vendor.minOrder}
              min={0}
              className={fieldCls}
            />
          </Field>
          <Field label="Commission (%)">
            <input
              type="number"
              name="commissionPct"
              defaultValue={vendor.commissionPct ?? ""}
              placeholder={`${platformCommissionPct} (platform rate)`}
              min={0}
              max={100}
              step={0.5}
              onFocus={(e) => e.currentTarget.select()}
              className={fieldCls}
            />
            <p className="mt-1 text-[11px] leading-snug text-muted">
              {vendor.commissionPct === null
                ? `Following the platform rate. Type a number to set a rate for this vendor only.`
                : `Overriding the platform rate of ${platformCommissionPct}%. Clear the field to follow it again.`}
            </p>
          </Field>
        </div>
        <Toggle
          name="deliveryAvailable"
          label="Delivery available"
          defaultChecked={vendor.deliveryAvailable}
        />
        <Toggle
          name="selfPickup"
          label="Self pickup available"
          defaultChecked={vendor.selfPickup}
        />
      </Section>

      <Section title="Location">
        <Field label="Address">
          <input name="address" defaultValue={vendor.address ?? ""} className={fieldCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Landmark">
            <input name="landmark" defaultValue={vendor.landmark ?? ""} className={fieldCls} />
          </Field>
          <Field label="Pincode">
            <input
              name="pincode"
              defaultValue={vendor.pincode ?? ""}
              inputMode="numeric"
              className={fieldCls}
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          The map pin (lat/lng) is set from the registration wizard&apos;s location
          step.
        </p>
      </Section>

      <Section
        title="How customers can pay this shop"
        description="Turn a method off and customers will not see it at checkout."
      >
        <Toggle
          name="acceptCod"
          label="Cash on delivery (COD)"
          defaultChecked={vendor.acceptCod}
          onChange={setAcceptCod}
        />
        <Toggle
          name="acceptOnline"
          label="Online payment (UPI, card, netbanking)"
          defaultChecked={vendor.acceptOnline}
          onChange={setAcceptOnline}
        />

        {!acceptCod && !acceptOnline ? (
          <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-2.5 text-[13px] font-medium text-deal">
            Turn on at least one payment method. With both off this shop cannot
            take any order.
          </p>
        ) : null}

        <Field
          label="Cash limit per order (₹)"
          hint="Above this amount the customer must pay online. Leave 0 for no limit."
        >
          <input
            type="number"
            name="codMaxOrder"
            defaultValue={vendor.codMaxOrder}
            min={0}
            step={10}
            disabled={!acceptCod}
            onChange={(e) => setCodLimit(Number(e.currentTarget.value) || 0)}
            onFocus={(e) => e.currentTarget.select()}
            className={fieldCls}
          />
          <p className="mt-1 text-[11px] leading-snug text-muted">
            {!acceptCod
              ? "Cash on delivery is off, so this limit does nothing."
              : codLimit > 0
                ? `Customers will see: “Orders above ₹${codLimit.toLocaleString("en-IN")} must be paid online.”`
                : "No limit — any order can be paid in cash."}
          </p>
        </Field>
      </Section>

      <Section
        title="Settlement"
        description="How and when this shop is paid what it has earned."
      >
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
          <p className="mt-1 text-[11px] leading-snug text-muted">
            {CYCLE_NOTE[cycle]} You can still pay any single order early from
            the order payouts screen.
          </p>
        </Field>

        <Field
          label="Other charges per order (₹)"
          hint="A fixed amount taken off this shop's payout for every delivered order — packaging, gateway fee, and so on."
        >
          <input
            type="number"
            name="otherChargesPerOrder"
            defaultValue={vendor.otherChargesPerOrder}
            min={0}
            onFocus={(e) => e.currentTarget.select()}
            className={fieldCls}
          />
        </Field>

        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
          What this shop is paid for each order:
          <br />
          <span className="text-ink">
            Food value − commission − GST on commission − other charges
          </span>
          <br />
          Delivery fee, customer GST and the rider tip are never part of the
          shop&apos;s share.
        </p>
      </Section>

      <Section title="Payout account">
        <Field label="UPI ID" hint="If set, bank details are optional.">
          <input name="upiId" defaultValue={vendor.upiId ?? ""} className={fieldCls} />
        </Field>
        <Field label="Account holder name">
          <input
            name="bankAccountName"
            defaultValue={vendor.bankAccountName ?? ""}
            className={fieldCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank name">
            <input name="bankName" defaultValue={vendor.bankName ?? ""} className={fieldCls} />
          </Field>
          <Field label="IFSC">
            <input name="bankIfsc" defaultValue={vendor.bankIfsc ?? ""} className={fieldCls} />
          </Field>
        </div>
        <Field label="Account number">
          <input
            name="bankAccountNumber"
            defaultValue={vendor.bankAccountNumber ?? ""}
            inputMode="numeric"
            className={fieldCls}
          />
        </Field>
      </Section>

      <Section title="Legal">
        <Field label="FSSAI number">
          <input name="fssaiNumber" defaultValue={vendor.fssaiNumber ?? ""} className={fieldCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GST number">
            <input name="gstNumber" defaultValue={vendor.gstNumber ?? ""} className={fieldCls} />
          </Field>
          <Field label="PAN number">
            <input name="panNumber" defaultValue={vendor.panNumber ?? ""} className={fieldCls} />
          </Field>
        </div>
      </Section>

      <div className="action-dock flex items-center gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Link href={`/admin/vendors/${vendor.id}`}>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
