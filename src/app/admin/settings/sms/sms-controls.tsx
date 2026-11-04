"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Switch, fieldCls } from "@/components/ui/field";
import type { VendorSmsRow } from "@/lib/data-access/vendor-order-sms";
import { saveSmsSettingsAction, saveVendorSmsAction } from "./actions";

const SAMPLE: Record<string, string> = {
  order: "A1B2C3",
  shop: "Sharma Dhaba",
  items: "3",
  total: "420",
  dishes: "2x Paneer Butter Masala, 1x Naan",
  instructions: " Instructions: less spicy.",
};

function preview(template: string): string {
  return template.replace(/\{(order|shop|items|total|dishes|instructions)\}/g, (_, k: string) => SAMPLE[k]);
}

/** The on/off switch and the message. */
export function SmsSettingsForm({
  enabled: savedEnabled,
  template: savedTemplate,
}: Readonly<{ enabled: boolean; template: string }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(savedEnabled);
  const [template, setTemplate] = useState(savedTemplate);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = (nextEnabled: boolean, nextTemplate: string, done: string) =>
    start(async () => {
      setMessage(null);
      const res = await saveSmsSettingsAction({ enabled: nextEnabled, template: nextTemplate });
      if (!res.ok) {
        setEnabled(savedEnabled);
        setMessage({ ok: false, text: res.error ?? "Couldn't save." });
        return;
      }
      setMessage({ ok: true, text: done });
      router.refresh();
    });

  return (
    <div className="admin-measure space-y-3">
      <label className="flex items-center gap-3 text-[13.5px] font-semibold text-ink">
        <Switch
          checked={enabled}
          disabled={pending}
          onChange={(on) => {
            setEnabled(on);
            save(on, savedTemplate, on ? "SMS is on." : "SMS is off.");
          }}
        />
        Send shops an SMS for new orders
      </label>

      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        maxLength={300}
        rows={2}
        aria-label="Message"
        className={fieldCls}
        disabled={pending}
      />
      <p className="text-[13px] text-muted">{preview(template)}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending || template === savedTemplate}
          onClick={() => save(enabled, template, "Message saved.")}
          className="c-btn c-btn-dark disabled:opacity-50"
        >
          Save message
        </button>
        {message ? (
          <p className={`text-[12.5px] font-medium ${message.ok ? "text-green" : "text-deal"}`}>{message.text}</p>
        ) : null}
      </div>
    </div>
  );
}

/** A shop's own SMS switch. */
export function ShopSmsSwitch({ shop }: Readonly<{ shop: VendorSmsRow }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <Switch
        id={`sms-${shop.restaurantId}`}
        label={`SMS for ${shop.name}`}
        checked={shop.enabled}
        disabled={pending}
        onChange={(on) =>
          start(async () => {
            setError(null);
            const res = await saveVendorSmsAction({
              restaurantId: shop.restaurantId,
              enabled: on,
              phone: shop.phone ?? "",
            });
            if (!res.ok) setError(res.error ?? "Couldn't save.");
            router.refresh();
          })
        }
      />
      {error ? <span className="text-[11.5px] font-medium text-deal">{error}</span> : null}
    </span>
  );
}

/**
 * The number a shop is texted on: the one it registered with, unless one was typed
 * here. Typing is only for a shop with none or a different one, so it stays out of
 * the way behind Edit.
 */
export function ShopNumber({ shop }: Readonly<{ shop: VendorSmsRow }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const number = shop.phone ?? shop.registeredNumber;
  const [value, setValue] = useState(number ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = (phone: string) =>
    start(async () => {
      setError(null);
      const res = await saveVendorSmsAction({ restaurantId: shop.restaurantId, enabled: shop.enabled, phone });
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      setEditing(false);
      router.refresh();
    });

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2.5">
        {number ? (
          <span className="text-data text-[13px] text-ink">{number}</span>
        ) : (
          <span className="text-[13px] text-[color:var(--c-ink-amber)]">No number</span>
        )}
        <button
          type="button"
          onClick={() => {
            setValue(number ?? "");
            setError(null);
            setEditing(true);
          }}
          className="text-[12.5px] font-semibold text-accent-ink hover:underline"
        >
          {number ? "Edit" : "Add"}
        </button>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`SMS number for ${shop.name}`}
        inputMode="tel"
        maxLength={20}
        autoFocus
        disabled={pending}
        className={`${fieldCls} h-8 w-40`}
      />
      <button
        type="button"
        disabled={pending || !value.trim()}
        // The registered number is not an override: saving it clears the typed one.
        onClick={() => save(value.trim() === shop.registeredNumber ? "" : value)}
        className="c-btn c-btn-dark h-8 disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" disabled={pending} onClick={() => setEditing(false)} className="c-btn-quiet">
        Cancel
      </button>
      {shop.phone && shop.registeredNumber ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => save("")}
          className="text-[12.5px] font-semibold text-accent-ink hover:underline disabled:opacity-50"
        >
          Use registered number
        </button>
      ) : null}
      {error ? <span className="w-full text-[11.5px] font-medium text-deal">{error}</span> : null}
    </span>
  );
}
