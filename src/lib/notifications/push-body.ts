/**
 * The OneSignal create-notification body, built without any server-only
 * import so scripts/qa/ring-protocol.ts can check it — in particular that a
 * silent "stop ringing" push carries no title or text, because one that did
 * would pop up as a blank notification on every web-push and old-APK device.
 */

import { HINDI_ENABLED } from "@/lib/i18n/lang";
import { sanitizeCard, type PushCard } from "./push-card";

export interface PushOptions {
  /** Deep-link opened when the notification is tapped (e.g. /orders/<id>). */
  url?: string;
  /** Arbitrary payload delivered with the push. */
  data?: Record<string, unknown>;
  /**
   * OneSignal priority; 10 = FCM high priority. Required for a ring: Android
   * only lets an app start its ringing service from a high-priority message.
   */
  priority?: number;
  /** Seconds OneSignal keeps trying a phone that is offline. */
  ttlSec?: number;
  /**
   * Data-only push: no title, no text, nothing shown on any device. Used for
   * "stop ringing" (lib/alerts/ring.ts).
   */
  silent?: boolean;
  /**
   * Layout for the Android apps (progress bar, ETA tile, code tiles, ...). The
   * title and text are still sent, so anything that cannot draw it shows them.
   */
  card?: PushCard;
  /**
   * A later push with the same id replaces the earlier one on the phone instead
   * of stacking, so an order shows one card that moves along ("order-<id>").
   */
  collapseId?: string;
}

/**
 * Notification copy. OneSignal requires `en` and picks the entry matching the
 * device language, so a Hindi phone reads `hi` and everything else falls back
 * to English. Most of this app's customers, riders and kitchens are Hindi-first.
 */
export interface PushText {
  en: string;
  hi?: string;
}

export function pushBody(
  appId: string,
  targeting: Record<string, unknown>,
  heading: PushText,
  message: PushText,
  opts: PushOptions,
  channelId: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { app_id: appId, ...targeting };
  if (opts.silent) {
    body.content_available = true;
    // Only the Android apps act on a data-only push. Sent to a browser, Chrome
    // may show its own "This site has been updated in the background" notice
    // for a push that displays nothing — exactly what a silent stop must avoid.
    body.isAndroid = true;
    body.isAnyWeb = false;
    body.isIos = false;
  } else {
    // Hindi is switched off app-wide (lib/i18n/lang.ts), so a Hindi-language
    // phone must not get the Hindi copy either.
    body.headings = HINDI_ENABLED ? heading : { en: heading.en };
    body.contents = HINDI_ENABLED ? message : { en: message.en };
    if (channelId) body.android_channel_id = channelId;
    if (opts.url) body.url = opts.url;
    if (opts.collapseId) body.collapse_id = opts.collapseId;
  }
  const card = !opts.silent && opts.card ? sanitizeCard(opts.card) : null;
  if (opts.data || card) body.data = { ...opts.data, ...(card && Object.keys(card).length ? { card } : {}) };
  if (opts.priority) body.priority = opts.priority;
  if (opts.ttlSec) body.ttl = opts.ttlSec;
  return body;
}
