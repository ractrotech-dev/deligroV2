"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { defaults, type FeatureMap } from "@/lib/features/catalog";
import { FeaturesProvider } from "@/components/features/features-provider";

type Setter = (features: Record<string, boolean>) => void;

const SetFeaturesContext = createContext<Setter>(() => {});

/**
 * The customer website's switches. Starts with the "for everyone" values, which the
 * layout already has, and takes this person's own answer when `CustomerFeatureSync`
 * streams in behind its Suspense boundary: the layout must not wait on the profile
 * read before sending a byte (scripts/qa/customer-layout.ts). Components read it
 * with `useFeature`, as in the portals.
 *
 * Hiding is only half of "off": the API routes refuse as well.
 */
export function CustomerFeaturesProvider({
  everyone,
  children,
}: Readonly<{ everyone: Record<string, boolean>; children: React.ReactNode }>) {
  const [own, setOwn] = useState<Record<string, boolean> | null>(null);
  const features = useMemo(() => ({ ...defaults(), ...everyone, ...own }) as FeatureMap, [everyone, own]);
  return (
    <SetFeaturesContext.Provider value={setOwn}>
      <FeaturesProvider features={features}>{children}</FeaturesProvider>
    </SetFeaturesContext.Provider>
  );
}

/** Hands this person's switches, read on the server, to the provider above. */
export function CustomerFeatureSync({ features }: Readonly<{ features: Record<string, boolean> }>) {
  const set = useContext(SetFeaturesContext);
  useEffect(() => set(features), [set, features]);
  return null;
}
