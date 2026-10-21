"use client";

import { createContext, useContext } from "react";
import { Lock } from "lucide-react";
import {
  FEATURE_OFF_MESSAGE,
  defaults,
  type FeatureKey,
  type FeatureMap,
} from "@/lib/features/catalog";

/**
 * The current account's feature switches, resolved on the server by the portal
 * layout (`getFeatures`) and handed down, so a client component can hide a
 * control with `useFeature(key)`.
 *
 * Hiding is only half of "off": the server action behind every control calls
 * `assertVendorFeature` as well. Default is each feature's own default (on,
 * except the sensitive manager powers), so a component outside a provider
 * behaves as it always did and never sees a power nobody granted.
 */
const FeaturesContext = createContext<FeatureMap>(defaults());

export function FeaturesProvider({
  features,
  children,
}: Readonly<{
  features: FeatureMap;
  children: React.ReactNode;
}>) {
  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>;
}

export function useFeature(key: FeatureKey): boolean {
  return useContext(FeaturesContext)[key];
}

export function useFeatures(): FeatureMap {
  return useContext(FeaturesContext);
}

/** What a page shows instead of a switched-off feature. */
export function FeatureOffNotice({ title }: Readonly<{ title: string }>) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-5 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted">
        <Lock className="size-5" />
      </span>
      <p className="text-[15px] font-bold text-ink">{title}</p>
      <p className="max-w-xs text-sm text-muted">{FEATURE_OFF_MESSAGE}</p>
    </div>
  );
}
