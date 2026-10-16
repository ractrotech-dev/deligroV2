"use client";

import { useCallback, useState } from "react";
import { useIsClient } from "@/lib/pwa/use-is-client";
import { Bell, BellOff, BellRing } from "lucide-react";
import { requestPushOptIn } from "@/components/notifications/onesignal-init";
import { pushSupport } from "@/lib/native/bridge";
import { useT } from "@/components/providers/lang-provider";

/**
 * The notification opt-in control.
 *
 * The rule this exists to honour: never call `Notification.requestPermission()`
 * on page load. A browser permission prompt has exactly one shot — a reflexive
 * "Block" is permanent from the app's side, recoverable only through browser
 * settings that most of this audience will never find. So the value is stated
 * first, and the prompt only follows a deliberate tap.
 *
 * The subscription itself is OneSignal's (see `onesignal-init.tsx`); this only
 * drives the browser-level permission, which is the gate in front of it.
 */

const APP_ID = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID ?? "";

type Permission =
  "default" | "granted" | "denied" | "unsupported" | "native" | "native-asked";

function currentPermission(): Permission {
  // Inside the Android app the WebView has no window.Notification; the
  // permission lives with the native push plugin (src/lib/native/bridge.ts).
  if (pushSupport() === "native") return "native";
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission as Permission;
}

export function PushOptIn() {
  // Read during the first client render rather than pushed in from an effect:
  // the server genuinely cannot know this, and a button that appears and then
  // changes shape a frame later reads as a glitch.
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const isClient = useIsClient();
  const [busy, setBusy] = useState(false);
  const t = useT();

  const enable = useCallback(async () => {
    if (pushSupport() === "native") {
      // The Android prompt (or, if it was refused before, the app's settings).
      requestPushOptIn();
      setPermission("native-asked");
      return;
    }
    if (!("Notification" in window)) return;
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result as Permission);
      // Subscribe explicitly rather than waiting for the SDK to notice the new
      // permission on some later page load; its change listener then POSTs the
      // id to /api/notifications/register (see onesignal-init.tsx).
      if (result === "granted") requestPushOptIn();
    } catch {
      setPermission(currentPermission());
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isClient) return null;

  // Push is wired to OneSignal; with no app id configured there is no delivery
  // path, so offering to turn it on would be a button that does nothing.
  if (!APP_ID) return null;

  if (permission === "unsupported") {
    return (
      <Row
        icon={<BellOff className="size-4" aria-hidden="true" />}
        title={t(
          "Not supported on this browser",
          "इस ब्राउज़र में यह सुविधा नहीं है",
        )}
        description={t(
          "Order updates will still appear on the Orders screen whenever you open the app.",
          "ऐप खोलने पर ऑर्डर की जानकारी ऑर्डर वाले पेज पर फिर भी दिखेगी।",
        )}
      />
    );
  }

  if (permission === "native-asked") {
    return (
      <Row
        icon={<BellRing className="size-4 text-green" aria-hidden="true" />}
        title={t(
          "Allow notifications in the prompt",
          "पूछे जाने पर नोटिफ़िकेशन की अनुमति दें",
        )}
        description={t(
          "If nothing appeared, turn them on in Android Settings → Apps → Deligro → Notifications.",
          "अगर कुछ नहीं दिखा, तो फ़ोन की सेटिंग → ऐप्स → Deligro → नोटिफ़िकेशन में जाकर चालू करें।",
        )}
      />
    );
  }

  if (permission === "granted") {
    return (
      <Row
        icon={<BellRing className="size-4 text-green" aria-hidden="true" />}
        title={t("Order updates are on", "ऑर्डर की सूचनाएं चालू हैं")}
        description={t(
          "We'll notify you when a shop accepts your order and when your rider is on the way. Turn them off in your browser or device settings.",
          "दुकान के ऑर्डर लेने पर और राइडर के निकलने पर हम आपको बताएंगे। बंद करने के लिए ब्राउज़र या फ़ोन की सेटिंग में जाएं।",
        )}
      />
    );
  }

  if (permission === "denied") {
    return (
      <Row
        icon={<BellOff className="size-4" aria-hidden="true" />}
        title={t("Notifications are blocked", "नोटिफ़िकेशन बंद हैं")}
        description={t(
          "Your browser is blocking them for this site. You can allow them again from the padlock or site-settings menu in the address bar.",
          "आपका ब्राउज़र इस साइट के नोटिफ़िकेशन रोक रहा है। पता लिखने वाली जगह पर ताले के निशान या साइट सेटिंग से फिर चालू कर सकते हैं।",
        )}
      />
    );
  }

  return (
    <div className="p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted">
          <Bell className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">
            {t("Get notified about your order", "अपने ऑर्डर की सूचना पाएं")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {t(
              "One notification when the kitchen accepts, one when your rider sets off, one on delivery. Nothing else — no offers, no marketing.",
              "एक सूचना जब रसोई ऑर्डर ले, एक जब राइडर निकले, और एक डिलीवरी पर। इसके अलावा कुछ नहीं — कोई ऑफ़र या विज्ञापन नहीं।",
            )}
          </p>
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="press mt-2.5 inline-flex rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-[color:var(--surface)] disabled:opacity-50"
          >
            {busy
              ? t("Waiting…", "रुकिए…")
              : t("Turn on notifications", "नोटिफ़िकेशन चालू करें")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  icon,
  title,
  description,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  description: string;
}>) {
  return (
    <div className="flex items-start gap-3 p-3.5">
      <span className="mt-0.5 text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          {description}
        </p>
      </div>
    </div>
  );
}
