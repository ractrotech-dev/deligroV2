"use client";

import { useEffect, useRef } from "react";
import { Share, X } from "lucide-react";
import type { T } from "@/lib/i18n/lang";

/**
 * The install suggestion.
 *
 * Shown only after the visit threshold in `useInstall`, never on a first visit,
 * and never again once dismissed. Two shapes, because the two platforms install
 * differently: Chromium hands us a real prompt, while iOS Safari has no API at
 * all and can only be told where the button is.
 */
export function InstallPrompt({
  manual,
  onInstall,
  onDismiss,
  t,
}: {
  /** iOS: no programmatic prompt exists, so describe the Share-sheet route. */
  manual: boolean;
  onInstall: () => void;
  onDismiss: () => void;
  /** From PwaProvider, which sits above the customer app's LangProvider. */
  t: T;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Make room for the card instead of covering what's under it. It floats
  // above the tab bar, and on a short phone it sat over the last row of every
  // page — "Sign out", "Contact us", a vendor's promotion actions — with no way
  // to scroll them clear until the card was dismissed (12 pages on an iPhone SE
  // in the 28 Sept phone audit). Its height is published as --install-inset,
  // which `.app-scroll::after` turns into extra scroll room (globals.css).
  //
  // Measured, not assumed: the room needed is the distance from the card's top
  // edge to the bottom of the scroller, less the padding the shell already
  // reserves there. Using the card's height alone was right only above a tab
  // bar — the manager app has none, and the card's 88px offset went uncounted.
  // Re-measured on a timer as well as on resize, because the card moves when
  // the basket bar appears beneath it (globals.css) without changing size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const scroller = el
        .closest(".app-shell")
        ?.querySelector<HTMLElement>(".app-scroll");
      const bottom = scroller
        ? scroller.getBoundingClientRect().bottom
        : window.innerHeight;
      const reserved = scroller
        ? Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
        : 0;
      const need = Math.max(
        0,
        Math.ceil(bottom - el.getBoundingClientRect().top + 12 - reserved),
      );
      root.style.setProperty("--install-inset", `${need}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    const timer = window.setInterval(publish, 1000);
    return () => {
      ro.disconnect();
      window.clearInterval(timer);
      root.style.removeProperty("--install-inset");
    };
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Install Deligro", "Deligro इंस्टॉल करें")}
      className="install-card pointer-events-auto fixed inset-x-3 z-[88] mx-auto max-w-sm rounded-xl border border-line bg-surface px-3.5 py-3 shadow-[var(--shadow-lg)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">
            {t("Install Deligro", "Deligro इंस्टॉल करें")}
          </p>
          {manual ? (
            <p className="mt-0.5 text-xs leading-snug text-muted">
              {t("Tap", "")}{" "}
              <Share
                className="inline-block size-3.5 -translate-y-px"
                aria-label={t("the Share button", "शेयर बटन")}
              />{" "}
              {t("then", "दबाएं, फिर")}{" "}
              <strong className="font-semibold">
                {t("Add to Home Screen", "होम स्क्रीन में जोड़ें")}
              </strong>{" "}
              {t(
                "to open Deligro like an app.",
                "चुनें — Deligro ऐप की तरह खुलेगा।",
              )}
            </p>
          ) : (
            <p className="mt-0.5 text-xs leading-snug text-muted">
              {t(
                "Add it to your home screen — opens faster, and works even on a weak connection.",
                "इसे होम स्क्रीन पर जोड़ें — जल्दी खुलेगा और कमज़ोर इंटरनेट पर भी चलेगा।",
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("Dismiss", "हटाएं")}
          className="press -m-1 rounded-lg p-1 text-muted"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {manual ? null : (
        <button
          type="button"
          onClick={onInstall}
          className="press mt-2.5 inline-flex rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-[color:var(--surface)]"
        >
          {t("Install", "इंस्टॉल करें")}
        </button>
      )}
    </div>
  );
}
