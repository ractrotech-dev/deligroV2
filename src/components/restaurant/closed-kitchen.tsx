"use client";

import { useState, useSyncExternalStore } from "react";
import { useLang } from "@/components/providers/lang-provider";
import { pick, type Bi } from "@/lib/i18n/lang";

/**
 * Cute filler so a closed shop isn't a wall of empty dark space.
 *
 * There are several personalities below and one is picked at random on each
 * visit — sometimes the napping pot, sometimes the chai break. The random pick
 * lives in a useState initializer (stable across re-renders) and we only reveal
 * it once mounted on the client, so the server HTML and first client paint agree
 * and there's no hydration mismatch on the random index.
 */
const VARIANTS: { art: string; badge: string; title: Bi; caption: Bi }[] = [
  {
    art: "🍲",
    badge: "😴",
    title: {
      en: "The kitchen's having a little nap",
      hi: "रसोई अभी थोड़ी झपकी ले रही है",
    },
    caption: {
      en: "Our chefs are off recharging their spice levels. Swing by during opening hours for the good stuff! 🌶️",
      hi: "हमारे शेफ़ अभी आराम कर रहे हैं। खुलने के समय पर आइए, तब बढ़िया खाना मिलेगा! 🌶️",
    },
  },
  {
    art: "👨‍🍳",
    badge: "💤",
    title: { en: "Chef has left the building", hi: "शेफ़ अभी घर गए हैं" },
    caption: {
      en: "The stoves are cold and the aprons are hung up. Come back during opening hours and we'll cook you something lovely.",
      hi: "चूल्हे ठंडे हैं और एप्रन टंगे हैं। खुलने के समय पर आइए, हम आपके लिए कुछ अच्छा बनाएंगे।",
    },
  },
  {
    art: "🥘",
    badge: "🌙",
    title: { en: "We're closed for now", hi: "अभी हम बंद हैं" },
    caption: {
      en: "The pans are resting under the moonlight. We'll be back and sizzling before you know it! ✨",
      hi: "कढ़ाई अभी आराम कर रही है। हम जल्दी ही फिर से खुलेंगे! ✨",
    },
  },
  {
    art: "🧑‍🍳",
    badge: "☕",
    title: { en: "Gone for a chai break", hi: "चाय पीने गए हैं" },
    caption: {
      en: "Our cooks are refueling on chai and gossip. Swing by later when the kadhai's hot again! ☕",
      hi: "हमारे रसोइये चाय और गपशप में लगे हैं। जब कढ़ाई फिर गरम हो, तब आइए! ☕",
    },
  },
  {
    art: "🍕",
    badge: "🛌",
    title: { en: "Out cold (like our ovens)", hi: "रसोई ठंडी पड़ी है" },
    caption: {
      en: "Even the best kitchens need their beauty sleep. Catch us during opening hours for something tasty!",
      hi: "अच्छी रसोई को भी आराम चाहिए। कुछ स्वादिष्ट खाने के लिए खुलने के समय पर आइए!",
    },
  },
];

// A no-op subscription: the mounted flag never changes after the first client
// render, so there's nothing to subscribe to.
const noop = () => () => {};

export function ClosedKitchen() {
  // false during SSR and the hydrating render, true once on the client — the
  // sanctioned no-effect way to tell "are we mounted yet?".
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const { lang } = useLang();
  // Cosmetic, but drawn from the Web Crypto source (global in browsers and on
  // the server) so it needs no exemption. Only read once mounted, so the SSR
  // pick and the client pick never have to agree.
  const [index] = useState(
    () => crypto.getRandomValues(new Uint32Array(1))[0] % VARIANTS.length,
  );

  // Reserve the space on the first paint so the content doesn't jump in.
  const v = mounted ? VARIANTS[index] : null;

  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center px-8 py-16 text-center">
      {v ? (
        <>
          <div className="relative mb-5 grid size-24 place-items-center rounded-[28px] bg-surface-2 text-[44px] leading-none">
            <span aria-hidden>{v.art}</span>
            <span
              aria-hidden
              className="absolute -right-2 -top-2 grid size-9 place-items-center rounded-full bg-bg text-xl shadow-sm"
            >
              {v.badge}
            </span>
          </div>
          <h3 className="text-heading">{pick(lang, v.title)}</h3>
          <p className="mt-1.5 max-w-[17rem] text-body text-muted">
            {pick(lang, v.caption)}
          </p>
        </>
      ) : null}
    </div>
  );
}
