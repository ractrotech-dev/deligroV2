"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, MapPin, Plus, Star, Trash2 } from "lucide-react";
import { AddAddressForm } from "@/components/addresses/add-address-form";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSavedAddresses } from "@/hooks/use-saved-addresses";
import { useT } from "@/components/providers/lang-provider";

export default function ProfileAddressesPage() {
  const t = useT();
  const { addresses, loading, create, remove, setDefault, refresh } =
    useSavedAddresses();
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The address the confirm dialog is open for, if any. */
  const [confirming, setConfirming] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      await remove(id);
      setConfirming(null);
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(id: string) {
    setBusyId(id);
    try {
      await setDefault(id);
    } finally {
      setBusyId(null);
    }
  }

  const showEmpty = addresses.length === 0 && !showAdd;

  return (
    <div className="relative min-h-full">
      <header className="glass sticky top-0 z-20 flex items-center gap-3 px-4 py-3">
        <Link
          href="/profile"
          aria-label={t("Back to profile", "प्रोफ़ाइल पर वापस")}
          className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="min-w-0 flex-1 text-[17px] font-extrabold tracking-tight">
          {t("Saved addresses", "सेव पते")}
        </h1>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          aria-label={t("Add address", "पता जोड़ें")}
          className="press grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink"
        >
          <Plus className="size-5" />
        </button>
      </header>

      <div className="px-4 pb-6 pt-3">
        {loading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" />{" "}
            {t("Loading addresses…", "पते लोड हो रहे हैं…")}
          </p>
        ) : null}
        {!loading && showEmpty ? (
          <div className="card p-6 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-blue/12 text-blue">
              <MapPin className="size-7" />
            </span>
            <p className="mt-4 text-[15px] font-bold">
              {t("No saved addresses", "कोई पता सेव नहीं है")}
            </p>
            <p className="mt-1 text-sm text-muted">
              {t(
                "Add where we should deliver your orders.",
                "बताएं कि आपका ऑर्डर कहां पहुंचाना है।",
              )}
            </p>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="press mt-4 rounded-full bg-accent px-6 py-3 text-sm font-bold text-[var(--on-accent)]"
            >
              {t("Add address", "पता जोड़ें")}
            </button>
          </div>
        ) : null}
        {!loading && !showEmpty ? (
          <ul className="space-y-3">
            {addresses.map((a) => (
              <li key={a.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue/12 text-blue">
                    <MapPin className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[15px] font-bold">
                      {a.label}
                      {a.isDefault ? (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-accent-ink">
                          {t("Default", "डिफ़ॉल्ट")}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-sm leading-snug text-muted">
                      {a.line}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  {!a.isDefault ? (
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => handleSetDefault(a.id)}
                      className="press inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink"
                    >
                      {busyId === a.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Star className="size-3.5" />
                      )}
                      {t("Set default", "डिफ़ॉल्ट बनाएं")}
                    </button>
                  ) : null}
                  {/* No longer dimmed on a default address. It was styled at
                      50% opacity — the universal sign for "you cannot do this"
                      — and then worked anyway, which is the worst of both: it
                      discouraged a legitimate action without preventing it, and
                      the thing it was discouraging (being left with no default)
                      is now handled properly in `deleteAddress`. */}
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => setConfirming(a.id)}
                    className="press inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-deal disabled:opacity-60"
                  >
                    <Trash2 className="size-3.5" /> {t("Remove", "हटाएं")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {/* `window.confirm` blocks the whole page with an OS dialog that names
            the localhost origin rather than the app, and cannot say which
            address is about to go. This one can. */}
        <ConfirmDialog
          open={confirming !== null}
          title={t("Remove this address?", "यह पता हटाएं?")}
          message={
            <>
              {addresses.find((a) => a.id === confirming)?.line}
              {addresses.find((a) => a.id === confirming)?.isDefault &&
              addresses.length > 1 ? (
                <span className="mt-2 block">
                  {t(
                    "It is your default — the next address will take over.",
                    "यह आपका डिफ़ॉल्ट पता है — इसकी जगह अगला पता डिफ़ॉल्ट बन जाएगा।",
                  )}
                </span>
              ) : null}
            </>
          }
          confirmLabel={t("Remove", "हटाएं")}
          cancelLabel={t("Cancel", "रद्द करें")}
          danger
          busy={busyId !== null && busyId === confirming}
          onConfirm={() => confirming && handleDelete(confirming)}
          onClose={() => setConfirming(null)}
        />

        {showAdd ? (
          <section className="card mt-4 overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-bold">
                {t("New address", "नया पता")}
              </h2>
            </div>
            <AddAddressForm
              onSave={async (input) => {
                await create(input);
                setShowAdd(false);
                await refresh();
              }}
              onCancel={() => setShowAdd(false)}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
