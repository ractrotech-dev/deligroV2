"use client";

import { RefreshCw } from "lucide-react";
import { applyUpdate } from "@/lib/pwa/service-worker";
import type { T } from "@/lib/i18n/lang";

/**
 * "A new version is ready." Shown only when a worker has finished installing
 * and is waiting — never on a first install, where there is no old version to
 * replace and nothing for the user to decide.
 *
 * Deliberately a prompt and not an automatic reload. The people using this app
 * are mid-order, mid-checkout, or mid-shift on a kitchen board; swapping the
 * running bundle under them would throw away whatever they had typed. They
 * choose the moment, or they get the update on their next natural reload.
 */
export function UpdateBanner({
  registration,
  onDismiss,
  t,
}: Readonly<{
  registration: ServiceWorkerRegistration;
  onDismiss: () => void;
  /** From PwaProvider, which sits above the customer app's LangProvider. */
  t: T;
}>) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed inset-x-3 z-[90] mx-auto max-w-sm rounded-xl border border-line bg-surface px-3.5 py-3 shadow-[var(--shadow-lg)]"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <p className="text-[13px] font-semibold text-ink">
        {t("New version available", "नया वर्ज़न आ गया है")}
      </p>
      <p className="mt-0.5 text-xs leading-snug text-muted">
        {t(
          "Reload to get the latest version of Deligro.",
          "Deligro का नया वर्ज़न पाने के लिए दोबारा लोड करें।",
        )}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => applyUpdate(registration)}
          className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-[color:var(--surface)]"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("Reload", "दोबारा लोड करें")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="press rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted"
        >
          {t("Later", "बाद में")}
        </button>
      </div>
    </div>
  );
}
