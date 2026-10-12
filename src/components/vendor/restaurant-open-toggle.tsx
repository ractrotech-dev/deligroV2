"use client";

import { useState, useTransition } from "react";
import { setRestaurantOpenAction } from "@/app/vendor/actions";
import { useFeature } from "@/components/features/features-provider";

export function RestaurantOpenToggle({
  isOpen,
  onPhoto = false,
}: {
  isOpen: boolean;
  /**
   * Drawn over the storefront photo. The pale-green pill is made for a light
   * surface; on the dark hero its green text all but disappeared (28 Sept
   * phone audit). Over a photo it takes the same dark glass as the chips
   * beside it, with the state carried by a coloured dot.
   */
  onPhoto?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  // Admin → Feature access. Off: the state is still shown, but as a label —
  // the admin decides when this shop opens (setRestaurantOpenAction refuses).
  const canToggle = useFeature("vendor.open_toggle");

  if (!canToggle) {
    return (
      <span
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold ${
          onPhoto
            ? "bg-black/60 text-white"
            : isOpen
              ? "bg-green-soft text-green"
              : "bg-surface-2 text-muted"
        }`}
      >
        {onPhoto ? (
          <span aria-hidden="true" className={`size-2 rounded-full ${isOpen ? "bg-green" : "bg-white/60"}`} />
        ) : null}
        {isOpen ? "Open" : "Closed"}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      title={error ? "Could not update status" : undefined}
      onClick={() =>
        startTransition(async () => {
          setError(false);
          try {
            await setRestaurantOpenAction(!isOpen);
          } catch {
            setError(true);
          }
        })
      }
      className={`press inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold ${
        onPhoto
          ? "bg-black/60 text-white backdrop-blur-sm"
          : error
            ? "bg-red-500/10 text-red-500"
            : isOpen
              ? "bg-green-soft text-green"
              : "bg-surface-2 text-muted"
      }`}
    >
      {onPhoto ? (
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${error ? "bg-red-500" : isOpen ? "bg-green" : "bg-white/60"}`}
        />
      ) : null}
      {error ? "Retry" : isOpen ? "Open" : "Closed"}
    </button>
  );
}
