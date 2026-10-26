"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Empty, Section, StatusText } from "@/components/admin/console";
import { Button } from "@/components/ui/button";
import { Field, Switch, Toggle, fieldCls } from "@/components/ui/field";
import type { OrderSmsSettings, VendorSmsRow } from "@/lib/data-access/vendor-order-sms";
import { saveSmsSettingsAction, saveVendorSmsAction, type SmsActionResult } from "./actions";

/** The template with sample values, as a shop would read it. */
function preview(template: string): string {
  const sample: Record<string, string> = { order: "A1B2C3", shop: "Sharma Dhaba", items: "3", total: "420" };
  return template.replace(/\{(order|shop|items|total)\}/g, (_, k: string) => sample[k]);
}

export function SmsManager({
  settings,
  shops,
  disabled,
}: Readonly<{ settings: OrderSmsSettings; shops: VendorSmsRow[]; disabled: boolean }>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [template, setTemplate] = useState(settings.template);
  const [query, setQuery] = useState("");

  function run(action: () => Promise<SmsActionResult>, done: string) {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      setSaved(done);
      router.refresh();
    });
  }

  const busy = disabled || pending;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? shops.filter((s) => s.name.toLowerCase().includes(q)) : shops;
  }, [shops, query]);

  return (
    <div className="admin-measure space-y-2">
      {error ? (
        <p role="alert" className="rounded-xl border border-deal/30 bg-deal-soft px-3.5 py-3 text-sm font-semibold text-deal">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="rounded-xl border border-green/30 bg-green-soft px-3.5 py-3 text-sm font-semibold text-green">
          {saved}
        </p>
      ) : null}

      <Section title="New-order SMS">
        <div className="space-y-3">
          <Toggle
            label="Send shops an SMS for every new order"
            description="Off sends nothing to any shop. The Partner app's ring is unaffected."
            checked={enabled}
            onChange={setEnabled}
          />
          {!settings.gatewayConfigured ? (
            <p className="text-xs text-muted">
              No SMS is sent until an SMS gateway is connected (ORDER_SMS_URL on the server). The OTP gateway can only
              send login codes.
            </p>
          ) : null}
          <Field label="Message" hint="Use {order}, {shop}, {items} and {total}. Indian gateways need it to match a DLT-registered template.">
            <textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              maxLength={300}
              rows={3}
              className={fieldCls}
              disabled={busy}
            />
          </Field>
          <p className="text-xs text-muted">Preview: {preview(template)}</p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run(() => saveSmsSettingsAction({ enabled, template }), "SMS settings saved.")}
          >
            Save
          </Button>
        </div>
      </Section>

      <Section title="Shops" meta={`${shops.filter((s) => s.enabled).length} of ${shops.length} receive SMS`}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shops"
          aria-label="Search shops"
          className={`${fieldCls} mb-2`}
        />
        {shown.length === 0 ? <Empty>No shops match.</Empty> : null}
        <ul className="divide-y divide-line">
          {shown.map((s) => (
            <ShopRow key={s.restaurantId} shop={s} busy={busy} onSave={run} />
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ShopRow({
  shop,
  busy,
  onSave,
}: Readonly<{
  shop: VendorSmsRow;
  busy: boolean;
  onSave: (action: () => Promise<SmsActionResult>, done: string) => void;
}>) {
  const [phone, setPhone] = useState(shop.phone ?? "");
  const number = shop.phone ?? shop.ownerMobile;
  return (
    <li className="flex flex-col gap-2 py-2.5 @3xl:flex-row @3xl:items-center">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{shop.name}</span>
        <StatusText tone={!shop.enabled ? "neutral" : number ? "green" : "amber"}>
          {!shop.enabled ? "SMS off" : number ? `Texts ${number}` : "No number — add one"}
        </StatusText>
      </span>
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder={shop.ownerMobile ? `Owner: ${shop.ownerMobile}` : "Mobile number"}
        aria-label={`SMS number for ${shop.name}`}
        inputMode="tel"
        maxLength={20}
        className={`${fieldCls} @3xl:w-56`}
        disabled={busy}
      />
      <span className="flex items-center gap-3">
        <Switch
          id={`sms-${shop.restaurantId}`}
          label={`SMS for ${shop.name}`}
          checked={shop.enabled}
          disabled={busy}
          onChange={(on) =>
            onSave(
              () => saveVendorSmsAction({ restaurantId: shop.restaurantId, enabled: on, phone }),
              on ? `SMS on for ${shop.name}.` : `SMS off for ${shop.name}.`
            )
          }
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || phone === (shop.phone ?? "")}
          onClick={() =>
            onSave(
              () => saveVendorSmsAction({ restaurantId: shop.restaurantId, enabled: shop.enabled, phone }),
              `Number saved for ${shop.name}.`
            )
          }
        >
          Save number
        </Button>
      </span>
    </li>
  );
}
