"use client";

import { createContext, useContext } from "react";
import { DEFAULT_CHARGES_CONFIG, type ChargesConfig } from "@/lib/pricing";

/**
 * The live fee/tax knobs from the Admin Settings tab, handed down to the client
 * components that quote a price *before* checkout — the basket sheet and the
 * discovery cards.
 *
 * Those two used to read the module constants in `pricing.ts` instead. Checkout
 * and `createOrder` already read `platform_settings`, so an admin who changed
 * the delivery fee or set a free-delivery threshold got a cart that advertised
 * one number and a bill that charged another — the exact divergence `pricing.ts`
 * was written to end, surviving one layer above it.
 *
 * Provided once in the customer layout, which is `force-dynamic` and reads the
 * settings row server-side, so the first paint is already correct — no flash of
 * a default fee, and no client fetch.
 */
const ChargesConfigContext = createContext<ChargesConfig | null>(null);

export function ChargesConfigProvider({
  config,
  children,
}: Readonly<{
  config: ChargesConfig;
  children: React.ReactNode;
}>) {
  return (
    <ChargesConfigContext.Provider value={config}>
      {children}
    </ChargesConfigContext.Provider>
  );
}

/**
 * The live charges config for the tree below the customer layout.
 *
 * Outside that layout there is no settings row in scope, so this falls back to
 * the module defaults rather than throwing — a price surface rendered somewhere
 * unexpected should still render. It complains in development, because a quote
 * drawn from defaults is exactly the bug this context exists to prevent and it
 * must not be able to reappear silently.
 */
export function useChargesConfig(): ChargesConfig {
  const config = useContext(ChargesConfigContext);
  if (config) return config;

  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "useChargesConfig: no ChargesConfigProvider above this component — " +
        "quoting the pricing.ts defaults, which may not be what the server bills."
    );
  }
  return DEFAULT_CHARGES_CONFIG;
}
