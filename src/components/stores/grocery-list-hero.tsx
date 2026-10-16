"use client";

import { useEffect, useRef, useState } from "react";
import { ShoppingBag, ImagePlus, X, RotateCcw } from "lucide-react";
import {
  useGroceryHistory,
  type GroceryListEntry,
} from "@/stores/grocery-history-store";
import { useLang } from "@/components/providers/lang-provider";
import type { Lang } from "@/lib/i18n/lang";

/**
 * "Order groceries" — three separate ways to reach the shop, all over WhatsApp,
 * no catalog or backend:
 *   1. Write a list in the app and send it (wa.me text deep link).
 *   2. Upload a photo of a list and send it (Web Share API → photo + text).
 *   3. Just open a WhatsApp chat with the shop.
 * Sits above the grocery stores on the Stores tab.
 */

/**
 * Fallback business WhatsApp, in international format, digits only (no +).
 *
 * Only reached when `platform_settings.support_whatsapp` is blank. It used to be
 * the ONLY number: all three grocery entry points sent orders here, while the
 * admin-editable setting — correctly used on the Help page — controlled nothing.
 * A change of business number, an ops handover or a second city meant grocery
 * orders kept arriving somewhere nobody was watching, with no way to redirect
 * them short of a deploy.
 */
const FALLBACK_WHATSAPP_NUMBER = "918234888856";

/** wa.me wants digits only. A stored "+91 82348 88856" has to be stripped. */
function toWaNumber(configured: string | undefined): string {
  const digits = (configured ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : FALLBACK_WHATSAPP_NUMBER;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB, matching the avatar upload limit
const OK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const WA_GREEN = "#25D366";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** e.g. "Tue 16Jul26"; in Hindi the locale's own short form. */
function formatDate(ts: number, lang: Lang) {
  const d = new Date(ts);
  if (lang === "hi") {
    return d.toLocaleDateString("hi-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }
  const day = String(d.getDate()).padStart(2, "0");
  return `${DOW[d.getDay()]} ${day}${MON[d.getMonth()]}${String(
    d.getFullYear(),
  ).slice(-2)}`;
}

type SavedAddress = { label: string; line: string } | null;

/** Official WhatsApp glyph. */
function WhatsAppIcon({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.549 4.142 1.595 5.945L0 24l6.335-1.652a11.882 11.882 0 005.71 1.454h.006c6.585 0 11.946-5.359 11.949-11.893a11.821 11.821 0 00-3.487-8.46" />
    </svg>
  );
}

export function GroceryListHero({
  savedAddress,
  whatsappNumber,
}: Readonly<{
  savedAddress: SavedAddress;
  /** `platform_settings.support_whatsapp`. Falls back when blank. */
  whatsappNumber?: string;
}>) {
  const { lang, t } = useLang();
  const waNumber = toWaNumber(whatsappNumber);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const history = useGroceryHistory((s) => s.history);
  const hydrate = useGroceryHistory((s) => s.hydrate);
  const record = useGroceryHistory((s) => s.record);

  // Load persisted history once on mount (the store guards SSR internally).
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  function addressLine() {
    return savedAddress
      ? `\n\nDeliver to: ${savedAddress.label} — ${savedAddress.line}`
      : "";
  }

  function openWhatsApp(text: string) {
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Feature 1 — send the typed list.
  function sendList() {
    const list = note.trim();
    if (!list) return;
    openWhatsApp(`Deligro grocery order 🛒\n\n${list}${addressLine()}`);
    record(list);
  }

  // One-tap reorder of a past list.
  function reorder(item: GroceryListEntry) {
    openWhatsApp(`Deligro grocery order 🛒\n\n${item.text}${addressLine()}`);
    record(item.text);
  }

  // Feature 2 — send the photo (with text) via the native share sheet.
  async function sendPhoto() {
    if (!photo) return;
    const message = `Deligro grocery order 🛒\n\n(My grocery list is in the attached photo.)${addressLine()}`;

    if (
      typeof navigator !== "undefined" &&
      navigator.canShare?.({ files: [photo] })
    ) {
      try {
        await navigator.share({ files: [photo], text: message });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // else fall through to the text link below
      }
    }
    openWhatsApp(message);
    setNotice(
      t(
        "WhatsApp opened with your list — attach the photo you selected.",
        "व्हाट्सऐप खुल गया — अब अपनी चुनी हुई फ़ोटो जोड़ें।",
      ),
    );
  }

  // Feature 3 — just start a chat.
  function chat() {
    openWhatsApp(`Hi Deligro 👋 I'd like to order groceries.${addressLine()}`);
  }

  function pickPhoto(file: File | null) {
    if (!file) return;
    if (!OK_TYPES.has(file.type)) {
      setError(
        t(
          "Please pick a JPG, PNG, or WebP image.",
          "कृपया जेपीजी, पीएनजी या वेबपी फ़ोटो चुनें।",
        ),
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(
        t(
          "That image is over 5 MB — try a smaller one.",
          "यह फ़ोटो 5 MB से बड़ी है — छोटी फ़ोटो चुनें।",
        ),
      );
      return;
    }
    setError(null);
    setNotice(null);
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
  }

  function clearPhoto() {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <section className="px-4">
      <div className="overflow-hidden rounded-3xl bg-[linear-gradient(150deg,#f2a71b_0%,#e59a01_55%,#d98600_100%)] p-5 text-white">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wide">
              <ShoppingBag className="size-3.5" /> {t("Groceries", "किराना")}
            </span>
            <h2 className="mt-3 text-[24px] font-extrabold leading-tight tracking-tight">
              {t("Order groceries", "किराना मंगाएं")}
            </h2>
            <p className="mt-1.5 text-[13.5px] font-medium leading-snug text-white/90">
              {t(
                "No time to browse? Send us your list and we shop it for you.",
                "समय नहीं है? अपनी सूची भेजें, हम सामान लेकर आएंगे।",
              )}
            </p>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pickdrop-rider.webp"
            alt=""
            aria-hidden
            decoding="async"
            className="pointer-events-none -mr-1 w-24 shrink-0 self-center"
          />
        </div>

        {/* Feature 1 — write a list */}
        <div className="mt-4 rounded-2xl bg-surface p-3.5 shadow-sm">
          <p className="text-[13px] font-bold text-ink">
            {t("Write your list", "अपनी सूची लिखें")}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={5}
            placeholder={t(
              "e.g. 2kg atta, 1 dozen eggs, Amul butter 500g, 1L milk…",
              "जैसे: 2 किलो आटा, 1 दर्जन अंडे, अमूल मक्खन 500 ग्राम, 1 लीटर दूध…",
            )}
            className="mt-2 min-h-[130px] w-full resize-none rounded-xl bg-surface-2 p-3.5 text-[14px] leading-relaxed text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-[#25D366]"
          />
          <button
            type="button"
            onClick={sendList}
            disabled={note.trim().length === 0}
            style={{ backgroundColor: WA_GREEN }}
            className="press mt-2.5 flex w-full items-center justify-center gap-2 rounded-full py-3 text-[14px] font-bold text-white shadow-sm transition disabled:opacity-45"
          >
            <WhatsAppIcon className="size-[18px]" />{" "}
            {t("Send list on WhatsApp", "सूची व्हाट्सऐप पर भेजें")}
          </button>
        </div>

        {/* Feature 2 — upload a photo */}
        <div className="mt-3 rounded-2xl bg-surface p-3.5 shadow-sm">
          <p className="text-[13px] font-bold text-ink">
            {t("Or upload a photo of your list", "या अपनी सूची की फ़ोटो भेजें")}
          </p>

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
          />

          {preview ? (
            <div className="mt-2 flex items-center gap-3 rounded-xl bg-surface-2 p-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt={t("Your grocery list", "आपकी किराना सूची")}
                className="size-14 shrink-0 rounded-lg object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                {t("Photo attached", "फ़ोटो जुड़ गई")}
              </span>
              <button
                type="button"
                onClick={clearPhoto}
                aria-label={t("Remove photo", "फ़ोटो हटाएं")}
                className="press grid size-8 shrink-0 place-items-center rounded-full bg-line text-ink"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="press mt-2 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line py-4 text-[13.5px] font-semibold text-muted"
            >
              <ImagePlus className="size-[18px]" />{" "}
              {t("Choose a photo", "फ़ोटो चुनें")}
            </button>
          )}

          {error ? (
            <p className="mt-2 text-[12.5px] font-semibold text-red-600">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            onClick={sendPhoto}
            disabled={!photo}
            style={{ backgroundColor: WA_GREEN }}
            className="press mt-2.5 flex w-full items-center justify-center gap-2 rounded-full py-3 text-[14px] font-bold text-white shadow-sm transition disabled:opacity-45"
          >
            <WhatsAppIcon className="size-[18px]" />{" "}
            {t("Send photo on WhatsApp", "फ़ोटो व्हाट्सऐप पर भेजें")}
          </button>
          {notice ? (
            <p className="mt-2 text-[12.5px] font-medium text-muted">
              {notice}
            </p>
          ) : null}
        </div>

        {/* Feature 3 — direct chat */}
        <button
          type="button"
          onClick={chat}
          style={{ color: WA_GREEN }}
          className="press mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-surface py-3 text-[14px] font-extrabold shadow-sm"
        >
          <WhatsAppIcon className="size-[18px]" />{" "}
          {t("Chat with us on WhatsApp", "व्हाट्सऐप पर हमसे बात करें")}
        </button>

        {/* Reorder history — past typed lists, one tap to send again */}
        {history.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-white/70">
              {t("Recent lists", "पिछली सूचियां")}
            </p>
            <ul className="mt-2 space-y-2">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => reorder(h)}
                    aria-label={t(
                      `Reorder list from ${formatDate(h.ts, lang)}`,
                      `${formatDate(h.ts, lang)} की सूची फिर से भेजें`,
                    )}
                    className="press flex w-full items-center gap-3 rounded-2xl bg-white/15 p-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-[11px] font-bold text-white/70">
                        {formatDate(h.ts, lang)}
                      </span>
                      <p className="truncate text-[13px] font-medium text-white">
                        {h.text}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[12px] font-bold text-[#c56a00]">
                      <RotateCcw className="size-3.5" />{" "}
                      {t("Reorder", "फिर से मंगाएं")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
