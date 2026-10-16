"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  ImageIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Field, Toggle, fieldCls, labelCls } from "@/components/ui/field";
import { Modal, ConfirmDialog } from "@/components/ui/confirm-dialog";
import { focusOnMount } from "@/lib/utils/focus";
import { MapPicker } from "@/components/location/map-picker";
import { PhoneOtpVerify } from "@/components/admin/phone-otp-verify";
import { DISH_CATEGORIES } from "@/lib/menu-categories";
import { isMapsConfigured } from "@/lib/maps/config";
import type {
  VendorDraftData,
  DraftMenuItem,
} from "@/lib/data-access/vendor-registration";
import {
  saveDraftAction,
  createVendorAccountAction,
  convertCustomerToVendorAction,
  createCategoryInlineAction,
} from "../actions";

const TC_VERSION = "2026-07-v2";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Domain labels exclude the dot that separates them, so the match is linear
// rather than backtracking over every way to split the domain.
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** A time-input variant that can shrink inside a 2-col grid without overflowing
 *  (native time controls have a wide intrinsic min-width; min-w-0 lets it flex).
 *  Built from the shared field so it picks up the console's proportions too. */
const timeCls = `${fieldCls} min-w-0`;

/** Verify the vendor's mobile via the admin verify-phone route (no session mint). */
async function verifyWizardPhone(
  phone: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/admin/vendors/verify-phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const data = await res.json();
    return { ok: res.ok && data.ok === true, error: data.error };
  } catch {
    return { ok: false, error: "network" };
  }
}

const STEPS = [
  "Basic info",
  "Business",
  "Location",
  "Payment",
  "Legal",
  "Menu",
  "Terms",
  "Review",
];

type WizardData = VendorDraftData & { confirmPassword?: string };

function validateStep(idx: number, d: WizardData): string | null {
  switch (idx) {
    case 0:
      if (!d.shopName?.trim()) return "Shop name is required.";
      if (!d.ownerName?.trim()) return "Owner name is required.";
      if (!d.mobile?.trim()) return "Mobile number is required.";
      if (!d.email?.trim() || !EMAIL.test(d.email))
        return "A valid email address is required.";
      if (d.password || d.confirmPassword) {
        if ((d.password ?? "").length < 8)
          return "Password must be at least 8 characters.";
        if (d.password !== d.confirmPassword) return "Passwords don't match.";
      }
      return null;
    case 1:
      if (!d.category?.trim()) return "Select a vendor category.";
      return null;
    case 2:
      if (!d.address?.trim()) return "Shop address is required.";
      return null;
    case 3: {
      const hasUpi = Boolean(d.upiId?.trim());
      const hasBank = Boolean(d.bankAccountNumber?.trim() && d.bankIfsc?.trim());
      if (!hasUpi && !hasBank)
        return "Add a UPI ID or bank account (number + IFSC).";
      return null;
    }
    case 5:
      for (const m of d.menuItems ?? []) {
        if (m.name?.trim() && (m.price == null || m.price < 0))
          return "Every named menu item needs a valid price.";
      }
      return null;
    case 6:
      if (!d.tcAccepted) return "Accept the terms & conditions to continue.";
      return null;
    default:
      return null;
  }
}

export function RegistrationWizard({
  initialData,
  initialStep,
  draftId: initialDraftId,
  categories,
}: Readonly<{
  initialData: WizardData;
  initialStep: number;
  draftId?: string;
  categories: string[];
}>) {
  const router = useRouter();
  const [data, setData] = useState<WizardData>(initialData);
  const [step, setStep] = useState(Math.min(initialStep, STEPS.length - 1));
  const [draftId, setDraftId] = useState<string | undefined>(initialDraftId);
  const [cats, setCats] = useState<string[]>(categories);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    vendorId: string;
    password?: string;
    existing?: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  // When the mobile is already a customer, the wizard asks whether to also make
  // them a vendor (attaching a shop to their existing account) instead of failing.
  const [confirmCustomer, setConfirmCustomer] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [converting, setConverting] = useState(false);
  // The draft id we last synced our form state from — lets us detect a resume.
  const [hydratedFor, setHydratedFor] = useState<string | undefined>(
    initialDraftId
  );

  // A client-side navigation from the drafts list to `?draft=<id>` stays on the
  // same route segment, so React reuses this component and `useState`'s initial
  // value goes stale — the resumed form would otherwise render blank. Re-sync
  // from the incoming draft *during render* (React's supported "adjust state
  // when a prop changes" pattern) whenever the URL points at a DIFFERENT draft
  // than the one we're already editing. The `!== draftId` guard skips our own
  // first save, which stamps the URL with the id we just created, so it never
  // wipes in-memory fields like the password.
  if (initialDraftId !== hydratedFor) {
    setHydratedFor(initialDraftId);
    if (initialDraftId && initialDraftId !== draftId) {
      setData(initialData);
      setStep(Math.min(initialStep, STEPS.length - 1));
      setDraftId(initialDraftId);
    }
  }

  const update = (patch: Partial<WizardData>) =>
    setData((d) => ({ ...d, ...patch }));

  async function persist(targetStep: number) {
    setSaving(true);
    setSavedAt(false);
    // Strip secrets before they leave the browser; the server strips again.
    const { password: _pw, confirmPassword: _cpw, ...safe } = data;
    void _pw;
    void _cpw;
    const res = await saveDraftAction(draftId ?? null, safe, targetStep);
    setSaving(false);
    if (res.ok && res.id) {
      setSavedAt(true);
      if (!draftId) {
        setDraftId(res.id);
        router.replace(`/admin/vendors/new?draft=${res.id}`, { scroll: false });
      }
    }
    return res.ok;
  }

  async function goNext() {
    const problem = validateStep(step, data);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const target = Math.min(step + 1, STEPS.length - 1);
    await persist(target);
    setStep(target);
  }

  function goPrev() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function saveDraftNow() {
    setError(null);
    await persist(step);
  }

  async function submit() {
    for (let i = 0; i <= 6; i++) {
      const problem = validateStep(i, data);
      if (problem) {
        setStep(i);
        setError(problem);
        return;
      }
    }
    setError(null);
    setSubmitting(true);
    const { confirmPassword: _cpw, ...payload } = data;
    void _cpw;
    const res = await createVendorAccountAction(payload, draftId);
    setSubmitting(false);
    // The mobile already belongs to a customer — ask before attaching a shop.
    if (res.existingCustomer) {
      setConfirmCustomer(res.existingCustomer);
      return;
    }
    if (!res.ok || !res.vendorId || !res.password) {
      setError(res.error ?? "Couldn't create the vendor.");
      return;
    }
    setResult({ vendorId: res.vendorId, password: res.password });
  }

  async function convertToVendor() {
    if (!confirmCustomer) return;
    setConverting(true);
    const { confirmPassword: _cpw, ...payload } = data;
    void _cpw;
    const res = await convertCustomerToVendorAction(
      payload,
      confirmCustomer.id,
      draftId
    );
    setConverting(false);
    setConfirmCustomer(null);
    if (!res.ok || !res.vendorId) {
      setError(res.error ?? "Couldn't add the vendor to that account.");
      return;
    }
    setResult({ vendorId: res.vendorId, existing: true });
  }

  async function addCategory(name: string) {
    const res = await createCategoryInlineAction(name);
    if (!res.ok || !res.name) {
      setError(res.error ?? "Couldn't add the category.");
      return;
    }
    setCats((c) => (c.includes(res.name!) ? c : [...c, res.name!]));
    update({ category: res.name });
  }

  const onReview = step === STEPS.length - 1;

  return (
    // Bottom padding clears the fixed action bar so the last field is reachable.
    <div className="space-y-4 pb-24">
      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold">
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </p>
          <span className="text-[11px] text-muted">
            {saving ? "Saving…" : savedAt ? "Draft saved" : ""}
          </span>
        </div>
        <div className="flex gap-1">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={
                "h-1.5 flex-1 rounded-full " +
                (i <= step ? "bg-accent" : "bg-surface-2")
              }
            />
          ))}
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
          {error}
        </p>
      ) : null}

      {step === 0 ? <BasicStep data={data} update={update} /> : null}
      {step === 1 ? (
        <BusinessStep data={data} update={update} cats={cats} onAddCategory={addCategory} />
      ) : null}
      {step === 2 ? <LocationStep data={data} update={update} /> : null}
      {step === 3 ? <PaymentStep data={data} update={update} /> : null}
      {step === 4 ? <LegalStep data={data} update={update} /> : null}
      {step === 5 ? <MenuStep data={data} update={update} /> : null}
      {step === 6 ? <TermsStep data={data} update={update} /> : null}
      {step === 7 ? <ReviewStep data={data} goTo={setStep} /> : null}

      {/* Action footer — three evenly balanced controls (Back · Draft · Next),
          docked just above the tab bar. See `.action-dock` for why it's fixed. */}
      <div className="action-dock flex items-center justify-between gap-2 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur">
        {step > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={goPrev}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        ) : (
          <Link href="/admin/vendors">
            <Button type="button" variant="secondary" size="sm">
              Cancel
            </Button>
          </Link>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={saveDraftNow}
          disabled={saving}
          title="Save draft"
        >
          <Save className="size-4" /> Draft
        </Button>
        {onReview ? (
          <Button type="button" size="sm" onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Create vendor
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={goNext} disabled={saving}>
            Next <ArrowRight className="size-4" />
          </Button>
        )}
      </div>

      {/* "Number is a customer — also make them a vendor?" */}
      <ConfirmDialog
        open={confirmCustomer !== null}
        title="Number is already a customer"
        message={
          <>
            <b className="text-ink">{confirmCustomer?.name}</b> is registered as a
            customer with this number. Also make them a vendor? Their customer
            account stays as-is and this shop is added to it — they keep shopping
            and sign in to their shop with the same number.
          </>
        }
        confirmLabel="Yes, add vendor"
        cancelLabel="No"
        busy={converting}
        onConfirm={convertToVendor}
        onClose={() => setConfirmCustomer(null)}
      />

      {/* Completion */}
      <Modal
        open={result !== null}
        onClose={() => result && router.push(`/admin/vendors/${result.vendorId}`)}
        title={result?.existing ? "Vendor added" : "Vendor created"}
      >
        {result?.existing ? (
          <p className="text-sm text-muted">
            The shop is live with status <b className="text-ink">pending</b>, added
            to the customer&apos;s existing account. They sign in with their
            registered mobile number (OTP) — no new password needed.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              The account is live with status <b className="text-ink">pending</b>.
              The owner signs in with their mobile number and this password. It
              is saved against the shop, so you can read it back from the vendor
              list if they lose it.
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-2.5">
              <code className="text-data flex-1 break-all px-1 text-[15px] font-semibold text-ink">
                {result?.password}
              </code>
              <button
                type="button"
                onClick={async () => {
                  if (!result?.password) return;
                  try {
                    await navigator.clipboard.writeText(result.password);
                    setCopied(true);
                  } catch {
                    /* clipboard blocked */
                  }
                }}
                className="press grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted hover:text-ink"
                aria-label="Copy password"
              >
                {copied ? <Check className="size-4 text-green" /> : <Copy className="size-4" />}
              </button>
            </div>
          </>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            onClick={() => result && router.push(`/admin/vendors/${result.vendorId}`)}
          >
            Open vendor
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------- steps ----------

type StepProps = {
  data: WizardData;
  update: (patch: Partial<WizardData>) => void;
};

function Card({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="card space-y-4 p-4">{children}</div>;
}

function BasicStep({ data, update }: Readonly<StepProps>) {
  return (
    <Card>
      <Field label="Shop name" required>
        <input
          className={fieldCls}
          value={data.shopName ?? ""}
          onChange={(e) => update({ shopName: e.target.value })}
        />
      </Field>
      <Field label="Owner name" required>
        <input
          className={fieldCls}
          value={data.ownerName ?? ""}
          onChange={(e) => update({ ownerName: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mobile" required>
          <input
            className={fieldCls}
            inputMode="tel"
            value={data.mobile ?? ""}
            // Editing the number invalidates any prior OTP verification.
            onChange={(e) => update({ mobile: e.target.value, phoneVerified: false })}
          />
        </Field>
        <Field label="Alt. mobile">
          <input
            className={fieldCls}
            inputMode="tel"
            value={data.altMobile ?? ""}
            onChange={(e) => update({ altMobile: e.target.value })}
          />
        </Field>
      </div>
      <div className="-mt-1 flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">
          Verify the mobile now, or later from the vendor&apos;s Edit screen.
        </p>
        <PhoneOtpVerify
          phone={data.mobile ?? ""}
          verified={data.phoneVerified ?? false}
          disabled={!data.mobile?.trim()}
          onVerified={() => update({ phoneVerified: true })}
          verify={verifyWizardPhone}
        />
      </div>
      <Field label="Email" required>
        <input
          className={fieldCls}
          type="email"
          value={data.email ?? ""}
          onChange={(e) => update({ email: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Password" hint="Blank = auto-generate">
          <input
            className={fieldCls}
            type="password"
            value={data.password ?? ""}
            onChange={(e) => update({ password: e.target.value })}
          />
        </Field>
        <Field label="Confirm password">
          <input
            className={fieldCls}
            type="password"
            value={data.confirmPassword ?? ""}
            onChange={(e) => update({ confirmPassword: e.target.value })}
          />
        </Field>
      </div>
      <LogoUpload data={data} update={update} />
      <p className="text-xs text-muted">
        The password isn&apos;t kept in the draft — re-enter it (or leave blank
        to auto-generate) before creating the vendor. Once the account exists it
        is readable from the vendor list and the Edit screen.
      </p>
    </Card>
  );
}

function LogoUpload({ data, update }: Readonly<StepProps>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/vendors/logo", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok || !json.url) {
        setError(
          json.error === "too_large"
            ? "Image is too large (max 5 MB)."
            : json.error === "invalid_type"
              ? "Use a JPG, PNG or WebP image."
              : "Upload failed. Try again."
        );
        return;
      }
      update({ logoUrl: json.url });
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <span className={labelCls}>Shop logo</span>
      <div className="flex items-center gap-3">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-surface-2 text-muted">
          {data.logoUrl ? (
            <Image
              src={data.logoUrl}
              alt="Logo preview"
              width={64}
              height={64}
              className="size-16 object-cover"
              unoptimized
            />
          ) : (
            <ImageIcon className="size-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <label className="press inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent">
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            {data.logoUrl ? "Replace logo" : "Upload logo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onFile}
              disabled={busy}
            />
          </label>
          {data.logoUrl ? (
            <button
              type="button"
              onClick={() => update({ logoUrl: undefined })}
              className="press ml-2 text-xs font-semibold text-muted hover:text-deal"
            >
              Remove
            </button>
          ) : null}
          <p className="mt-1 text-[11px] text-muted">JPG, PNG or WebP · up to 5 MB.</p>
        </div>
      </div>
      {error ? <p className="text-xs font-medium text-deal">{error}</p> : null}
    </div>
  );
}

function BusinessStep({
  data,
  update,
  cats,
  onAddCategory,
}: StepProps & { cats: string[]; onAddCategory: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  return (
    <Card>
      <Field label="Vendor category" required>
        <select
          className={fieldCls}
          value={data.category ?? ""}
          onChange={(e) => {
            if (e.target.value === "__add") {
              setAdding(true);
              return;
            }
            update({ category: e.target.value });
          }}
        >
          <option value="">Select a category…</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="__add">+ Add new category…</option>
        </select>
      </Field>
      {adding ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="New category name">
              <input
                className={fieldCls}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                ref={focusOnMount}
              />
            </Field>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (newName.trim()) {
                onAddCategory(newName.trim());
                setNewName("");
                setAdding(false);
              }
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      <Field label="Shop description">
        <textarea
          className={fieldCls}
          rows={2}
          value={data.description ?? ""}
          onChange={(e) => update({ description: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Opening time">
          <input
            className={timeCls}
            type="time"
            value={data.openingTime ?? ""}
            onChange={(e) => update({ openingTime: e.target.value })}
          />
        </Field>
        <Field label="Closing time">
          <input
            className={timeCls}
            type="time"
            value={data.closingTime ?? ""}
            onChange={(e) => update({ closingTime: e.target.value })}
          />
        </Field>
      </div>
      <div className="space-y-1.5">
        <span className={labelCls}>Weekly off</span>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = (data.weeklyOff ?? []).includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() =>
                  update({
                    weeklyOff: on
                      ? (data.weeklyOff ?? []).filter((x) => x !== d)
                      : [...(data.weeklyOff ?? []), d],
                  })
                }
                className={
                  "press rounded-full px-3 py-1.5 text-sm font-semibold " +
                  (on ? "bg-accent text-[var(--on-accent)]" : "bg-surface-2 text-muted")
                }
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Minimum order (₹)">
        <input
          className={fieldCls}
          type="number"
          min={0}
          value={data.minOrder ?? 0}
          onChange={(e) => update({ minOrder: Number(e.target.value) })}
        />
      </Field>
      <Toggle
        label="Delivery available"
        checked={data.deliveryAvailable ?? true}
        onChange={(v) => update({ deliveryAvailable: v })}
      />
      <Toggle
        label="Self pickup available"
        checked={data.selfPickup ?? false}
        onChange={(v) => update({ selfPickup: v })}
      />
    </Card>
  );
}

function LocationStep({ data, update }: Readonly<StepProps>) {
  const initial =
    typeof data.lat === "number" && typeof data.lng === "number"
      ? { lat: data.lat, lng: data.lng }
      : null;
  return (
    <Card>
      {isMapsConfigured ? (
        <MapPicker
          initial={initial}
          onPick={(loc) =>
            update({ lat: loc.lat, lng: loc.lng, address: loc.address || data.address })
          }
        />
      ) : (
        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-xs text-muted">
          Map picker needs NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Enter the address
          manually below — the pin can be set later.
        </p>
      )}
      <Field label="Shop address" required>
        <textarea
          className={fieldCls}
          rows={2}
          value={data.address ?? ""}
          onChange={(e) => update({ address: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Landmark">
          <input
            className={fieldCls}
            value={data.landmark ?? ""}
            onChange={(e) => update({ landmark: e.target.value })}
          />
        </Field>
        <Field label="Pincode">
          <input
            className={fieldCls}
            inputMode="numeric"
            value={data.pincode ?? ""}
            onChange={(e) => update({ pincode: e.target.value })}
          />
        </Field>
      </div>
      {initial ? (
        <p className="text-xs text-muted">
          Pin: {data.lat?.toFixed(5)}, {data.lng?.toFixed(5)}
        </p>
      ) : null}
    </Card>
  );
}

function PaymentStep({ data, update }: Readonly<StepProps>) {
  return (
    <Card>
      <p className="text-xs text-muted">
        Add a UPI ID or bank account (at least one is required).
      </p>
      <Field label="UPI ID">
        <input
          className={fieldCls}
          placeholder="name@bank"
          value={data.upiId ?? ""}
          onChange={(e) => update({ upiId: e.target.value })}
        />
      </Field>
      <div className="border-t border-line pt-3">
        <span className={labelCls}>Bank account</span>
      </div>
      <Field label="Account holder name">
        <input
          className={fieldCls}
          value={data.bankAccountName ?? ""}
          onChange={(e) => update({ bankAccountName: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bank name">
          <input
            className={fieldCls}
            value={data.bankName ?? ""}
            onChange={(e) => update({ bankName: e.target.value })}
          />
        </Field>
        <Field label="IFSC">
          <input
            className={fieldCls}
            value={data.bankIfsc ?? ""}
            onChange={(e) => update({ bankIfsc: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Account number">
        <input
          className={fieldCls}
          inputMode="numeric"
          value={data.bankAccountNumber ?? ""}
          onChange={(e) => update({ bankAccountNumber: e.target.value })}
        />
      </Field>
      <Field label="Admin commission (%)">
        <input
          className={fieldCls}
          type="number"
          min={0}
          max={100}
          step={0.5}
          placeholder="Platform rate"
          onFocus={(e) => e.currentTarget.select()}
          value={data.commissionPct ?? ""}
          onChange={(e) =>
            // Blank = inherit the platform rate. Only a typed number becomes an
            // override, so a shop registered without a rate follows the
            // platform instead of being pinned at 0% forever.
            update({
              commissionPct:
                e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        />
      </Field>
    </Card>
  );
}

function LegalStep({ data, update }: Readonly<StepProps>) {
  return (
    <Card>
      <Field label="FSSAI number">
        <input
          className={fieldCls}
          value={data.fssaiNumber ?? ""}
          onChange={(e) => update({ fssaiNumber: e.target.value })}
        />
      </Field>
      <Field label="GST number">
        <input
          className={fieldCls}
          value={data.gstNumber ?? ""}
          onChange={(e) => update({ gstNumber: e.target.value })}
        />
      </Field>
      <Field label="PAN number">
        <input
          className={fieldCls}
          value={data.panNumber ?? ""}
          onChange={(e) => update({ panNumber: e.target.value })}
        />
      </Field>
      <p className="text-xs text-muted">
        Certificate &amp; document uploads arrive in Phase 3.
      </p>
    </Card>
  );
}

function MenuStep({ data, update }: Readonly<StepProps>) {
  const items = data.menuItems ?? [];
  const setItem = (i: number, patch: Partial<DraftMenuItem>) =>
    update({ menuItems: items.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const addItem = () =>
    update({
      menuItems: [
        ...items,
        { name: "", price: 0, veg: true, available: true, category: null },
      ],
    });
  const removeItem = (i: number) =>
    update({ menuItems: items.filter((_, idx) => idx !== i) });

  return (
    <Card>
      <p className="text-xs text-muted">
        Add a few dishes now, or skip and manage the full menu later. Category
        here is the dish section (e.g. Starters, Desserts) — not the shop type.
      </p>

      <MenuBulkImport data={data} update={update} />

      <datalist id="dish-categories">
        {DISH_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {items.length === 0 ? (
        <p className="rounded-xl bg-surface-2 px-3.5 py-4 text-center text-sm text-muted">
          No items yet.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((m, i) => (
            <div key={i} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted">Item {i + 1}</span>
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  className="press grid size-7 place-items-center rounded-full text-muted hover:text-deal"
                  aria-label="Remove item"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <div className="mt-2 space-y-2">
                <input
                  className={fieldCls}
                  placeholder="Item name"
                  value={m.name}
                  onChange={(e) => setItem(i, { name: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className={fieldCls}
                    type="number"
                    min={0}
                    placeholder="Price ₹"
                    value={m.price}
                    onChange={(e) => setItem(i, { price: Number(e.target.value) })}
                  />
                  <input
                    className={fieldCls}
                    list="dish-categories"
                    placeholder="Dish category"
                    value={m.category ?? ""}
                    onChange={(e) => setItem(i, { category: e.target.value || null })}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setItem(i, { veg: !m.veg })}
                    className={
                      "press flex-1 rounded-xl px-3 py-2 text-sm font-semibold " +
                      (m.veg ? "bg-green-soft text-green" : "bg-surface-2 text-muted")
                    }
                  >
                    {m.veg ? "Veg" : "Non-veg"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setItem(i, { available: !m.available })}
                    className={
                      "press flex-1 rounded-xl px-3 py-2 text-sm font-semibold " +
                      (m.available ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")
                    }
                  >
                    {m.available ? "Available" : "Sold out"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={addItem}>
        <Plus className="size-4" /> Add item
      </Button>
    </Card>
  );
}

/** Column order for the wizard menu template (also the keys read back). */
const MENU_COLUMNS = ["Name", "Category", "Description", "Price", "Veg (Yes/No)", "Available (Yes/No)"];

/** A cell as text. Without `cellDates`, sheet_to_json yields only primitives. */
function menuCellText(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : "";
}

function menuTruthy(v: unknown, fallback = true): boolean {
  const s = menuCellText(v).trim().toLowerCase();
  if (!s) return fallback;
  return /^(y|yes|true|1|veg|available|on)$/.test(s);
}

function menuNumber(v: unknown): number {
  const s = menuCellText(v).replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Bulk-add dishes from an .xlsx sheet straight into the draft (no DB yet). */
function MenuBulkImport({ data, update }: Readonly<StepProps>) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([
      MENU_COLUMNS,
      ["Paneer Tikka", "Starters", "Char-grilled", 220, "Yes", "Yes"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Menu");
    XLSX.writeFile(wb, "menu-template.xlsx");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setNote(null);
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      const parsed: DraftMenuItem[] = raw
        .map((r) => ({
          name: String(r["Name"] ?? "").trim(),
          category: String(r["Category"] ?? "").trim() || null,
          description: String(r["Description"] ?? "").trim() || null,
          price: menuNumber(r["Price"]),
          veg: menuTruthy(r["Veg (Yes/No)"], true),
          available: menuTruthy(r["Available (Yes/No)"], true),
        }))
        .filter((m) => m.name.length > 0);

      if (parsed.length === 0) {
        setNote("No named rows found in that sheet.");
        return;
      }
      update({ menuItems: [...(data.menuItems ?? []), ...parsed] });
      setNote(`Added ${parsed.length} item${parsed.length === 1 ? "" : "s"} from the sheet.`);
    } catch {
      setNote("Couldn't read that file. Use the .xlsx template.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-line p-3">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="size-4 text-accent" />
        <span className="text-xs font-semibold text-ink">Bulk upload (Excel)</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={downloadTemplate}>
          <Download className="size-4" /> Template
        </Button>
        <label className="press inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Upload .xlsx
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={onFile}
            disabled={busy}
          />
        </label>
      </div>
      {note ? <p className="mt-2 text-[11px] font-medium text-muted">{note}</p> : null}
    </div>
  );
}

function LegalClause({ n, title, children }: Readonly<{ n: number; title: string; children: React.ReactNode }>) {
  return (
    <div>
      <p className="font-semibold text-ink">
        {n}. {title}
      </p>
      <p className="mt-0.5">{children}</p>
    </div>
  );
}

function TermsStep({ data, update }: Readonly<StepProps>) {
  return (
    <Card>
      <div>
        <h2 className="text-heading text-[15px]">Vendor Partner Agreement</h2>
        <p className="mt-0.5 text-xs text-muted">
          Version {TC_VERSION} · This Agreement is entered into between Deligro
          (&quot;the Platform&quot;) and the vendor named in this registration
          (&quot;the Vendor&quot;).
        </p>
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto rounded-xl border border-line bg-surface-2 p-3.5 text-xs leading-relaxed text-muted">
        <LegalClause n={1} title="Appointment & Scope">
          The Vendor is onboarded as an independent partner to list and sell food
          and beverage items through the Platform. Nothing in this Agreement
          creates an employment, partnership, agency, or joint-venture
          relationship between the parties.
        </LegalClause>
        <LegalClause n={2} title="Listings, Pricing & Availability">
          The Vendor warrants that all menu items, prices, taxes, images, and
          availability it publishes are accurate and current, and undertakes to
          honour every order placed at the listed price and to keep unavailable
          items marked as such.
        </LegalClause>
        <LegalClause n={3} title="Food Safety & Compliance">
          The Vendor shall prepare, package, and store all items hygienically and
          in compliance with the Food Safety and Standards Act, 2006, and all
          applicable laws. The Vendor shall hold and keep valid a FSSAI licence,
          GST registration (where applicable), and any other statutory permits,
          and shall furnish proof on request.
        </LegalClause>
        <LegalClause n={4} title="Commission & Settlement">
          The Vendor authorises the Platform to deduct the agreed commission (as
          recorded on this registration) plus applicable taxes and payment-gateway
          charges from the value of each order. Net payouts are remitted to the
          bank account or UPI ID provided, on the Platform&apos;s standard
          settlement cycle.
        </LegalClause>
        <LegalClause n={5} title="Orders, Cancellations & Refunds">
          The Vendor agrees to accept and prepare confirmed orders promptly and to
          abide by the Platform&apos;s cancellation and refund policies. Refunds
          arising from Vendor error, delay, or quality issues may be recovered from
          the Vendor&apos;s settlement.
        </LegalClause>
        <LegalClause n={6} title="Conduct & Quality">
          The Vendor shall deal fairly and professionally with customers and
          delivery partners, and shall not engage in fraudulent, unsafe, or
          discriminatory conduct. Repeated quality complaints may affect the
          Vendor&apos;s visibility on the Platform.
        </LegalClause>
        <LegalClause n={7} title="Suspension & Termination">
          The Platform may suspend or terminate the Vendor&apos;s account, with or
          without notice, for breach of this Agreement, statutory
          non-compliance, or conduct that harms customers or the Platform&apos;s
          reputation. Either party may terminate on written notice; sums accrued up
          to termination remain payable.
        </LegalClause>
        <LegalClause n={8} title="Liability & Indemnity">
          The Vendor is solely responsible for the quality, safety, and legality of
          its products and shall indemnify the Platform against claims, penalties,
          or losses arising from the Vendor&apos;s items, acts, or omissions.
        </LegalClause>
        <LegalClause n={9} title="Data & Confidentiality">
          Each party shall keep the other&apos;s non-public information
          confidential and process customer data only as needed to fulfil orders
          and in line with the Platform&apos;s privacy policy and applicable data
          protection law.
        </LegalClause>
        <LegalClause n={10} title="Governing Law">
          This Agreement is governed by the laws of India, and the courts at the
          Platform&apos;s registered office shall have exclusive jurisdiction.
        </LegalClause>
        <p className="pt-1 text-[11px]">
          Acceptance is recorded with the operator&apos;s identity, a timestamp,
          and this version number for audit.
        </p>
      </div>
      <label className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
        <input
          type="checkbox"
          checked={data.tcAccepted ?? false}
          onChange={(e) =>
            update({
              tcAccepted: e.target.checked,
              tcVersion: e.target.checked ? TC_VERSION : undefined,
            })
          }
          className="mt-0.5 size-5 shrink-0 accent-accent"
        />
        <span className="text-sm font-medium text-ink">
          I confirm the Vendor has read, understood, and agreed to this Vendor
          Partner Agreement ({TC_VERSION}).
        </span>
      </label>
    </Card>
  );
}

function ReviewStep({
  data,
  goTo,
}: Readonly<{
  data: WizardData;
  goTo: (step: number) => void;
}>) {
  const rows: { label: string; value: string; step: number }[] = [
    { label: "Shop", value: data.shopName ?? "—", step: 0 },
    { label: "Owner", value: data.ownerName ?? "—", step: 0 },
    { label: "Mobile", value: data.mobile ?? "—", step: 0 },
    { label: "Email", value: data.email ?? "—", step: 0 },
    { label: "Category", value: data.category ?? "—", step: 1 },
    { label: "Min order", value: `₹${data.minOrder ?? 0}`, step: 1 },
    { label: "Address", value: data.address ?? "—", step: 2 },
    {
      label: "Payment",
      value: data.upiId?.trim()
        ? `UPI ${data.upiId}`
        : data.bankAccountNumber
          ? `A/C ${data.bankAccountNumber}`
          : "—",
      step: 3,
    },
    {
      label: "Commission",
      value:
        data.commissionPct === undefined || data.commissionPct === null
          ? "Platform rate"
          : `${data.commissionPct}%`,
      step: 3,
    },
    { label: "FSSAI", value: data.fssaiNumber ?? "—", step: 4 },
    { label: "Menu items", value: String((data.menuItems ?? []).filter((m) => m.name?.trim()).length), step: 5 },
    { label: "Terms", value: data.tcAccepted ? "Accepted" : "Not accepted", step: 6 },
  ];
  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-line bg-surface p-3.5">
        <dl className="space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start justify-between gap-3">
              <dt className="text-sm text-muted">{r.label}</dt>
              <dd className="flex items-center gap-2 text-right text-sm font-medium text-ink">
                <span className="max-w-[180px] truncate">{r.value}</span>
                <button
                  type="button"
                  onClick={() => goTo(r.step)}
                  className="press text-xs font-semibold text-accent"
                >
                  Edit
                </button>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="px-1 text-xs text-muted">
        Creating the vendor generates a login account (status pending) and a
        password to hand off. The owner signs in with their mobile number.
      </p>
    </div>
  );
}
