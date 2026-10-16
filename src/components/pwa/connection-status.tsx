"use client";

import { useEffect, useState } from "react";
import { CloudOff, Wifi } from "lucide-react";
import type { T } from "@/lib/i18n/lang";

/**
 * The connection pill.
 *
 * Only two states are ever shown, and only one of them persists:
 *
 *   offline  — stays up for as long as the connection is gone, because the user
 *              needs to know why nothing is loading.
 *   back online — a brief confirmation, then it leaves.
 *
 * There is no permanent "online" badge. A green dot that is always lit is
 * furniture: it costs a row of screen on a 402px frame and tells the user
 * something they can already see, which is that the app is working.
 */
export function ConnectionStatus({
  online,
  slow,
  recoveredAt,
  t,
}: Readonly<{
  online: boolean;
  slow: boolean;
  /** Only used to decide whether a recovery has happened at all. The parent
   *  remounts this component on each one (see its `key`), which is what resets
   *  the timer below without a setState in an effect body. */
  recoveredAt: number;
  /** From PwaProvider, which sits above the customer app's LangProvider. */
  t: T;
}>) {
  const [showRecovered, setShowRecovered] = useState(recoveredAt > 0);

  useEffect(() => {
    if (!showRecovered) return;
    const timer = setTimeout(() => setShowRecovered(false), 2600);
    return () => clearTimeout(timer);
  }, [showRecovered]);

  const visible = !online || showRecovered;
  if (!visible) return null;

  return (
    <div
      // polite, not assertive: losing signal is worth announcing but must not
      // interrupt a screen reader mid-sentence.
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[85] flex justify-center px-3"
      style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <span
        className={
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold shadow-[var(--shadow-md)] " +
          (online
            ? "bg-green text-[color:var(--on-green)]"
            : "bg-ink text-[color:var(--surface)]")
        }
      >
        {online ? (
          <>
            <Wifi className="size-3.5" aria-hidden="true" />
            {t("Back online", "इंटरनेट वापस आ गया")}
          </>
        ) : (
          <>
            <CloudOff className="size-3.5" aria-hidden="true" />
            {slow
              ? t("Very weak connection", "इंटरनेट बहुत कमज़ोर है")
              : t("No connection", "इंटरनेट नहीं है")}
          </>
        )}
      </span>
    </div>
  );
}
