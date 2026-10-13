"use client";

import type { Bi } from "@/lib/i18n/lang";
import { create } from "zustand";
import { reverseGeocode } from "@/lib/utils/geocode";
import { PINNED_LOCATION } from "@/lib/location/pinned";

/**
 * Current-location state for the delivery header.
 *
 * The header starts at the pinned delivery city and users set their area
 * deliberately from the /location page (detect or pick) — there's no auto
 * permission popup on app open. Detection there triggers the browser's own
 * native Geolocation prompt.
 */

export type LocationStatus =
  | "idle" // not asked yet
  | "loading" // waiting on the device
  | "granted" // we have a current fix
  | "stale" // restored from cache, older than CACHE_TTL_MS — usable, not current
  | "denied" // user/OS refused
  | "unsupported"; // no geolocation on this device

export interface Coords {
  lat: number;
  lng: number;
}

/** A resolved place, before it is anything the customer has agreed to. */
export interface Place {
  label: string;
  sublabel: string | null;
  coords: Coords | null;
}

interface LocationState {
  status: LocationStatus;
  label: string | null; // resolved area, e.g. "Bandra West"
  sublabel: string | null; // fuller line, e.g. "Mumbai, Maharashtra"
  coords: Coords | null;
  /**
   * How old `coords` is, in ms — null when they were just resolved, or when the
   * age is unknowable (a cache entry written before timestamping existed).
   * Surfaces that quote a distance use it to say so rather than presenting a
   * weeks-old measurement as a live one.
   */
  coordsAgeMs: number | null;
  /** In both languages; the screen picks the customer's. */
  error: Bi | null;
  askOpen: boolean; // in-app permission explainer visibility
  blocked: boolean; // device/browser refused — only Settings can undo it
  /**
   * A saved delivery address is the active location. While it is, a GPS fix or
   * a searched place never replaces it silently: it waits in `candidate` until
   * the customer confirms it, so the header cannot name a place that checkout
   * will not deliver to. False for guests and for customers with nothing saved,
   * who have no address to protect and are placed by detection as before.
   */
  savedActive: boolean;
  /** A place found by GPS or search that has not been confirmed. */
  candidate: Place | null;

  /** Decide whether to raise the explainer sheet on app open. */
  maybePrompt: () => void;
  openAsk: () => void;
  closeAsk: () => void;
  /** Kick off a real detection (triggers the native OS prompt). */
  detect: () => void;
  /** Adopt a location the user chose by hand — a search result or saved address. */
  setPlace: (place: {
    label: string;
    sublabel?: string | null;
    coords?: Coords | null;
  }) => void;
  /**
   * Make a saved address the active location. In memory only: the saved address
   * is read from the server on every launch, so it is not copied into the
   * browser's storage where the next person on this phone could find it.
   */
  adoptSaved: (place: {
    label: string;
    sublabel?: string | null;
    coords?: Coords | null;
  }) => void;
  /** No saved address any more (all deleted, or signed out): detection applies directly again. */
  releaseSaved: () => void;
  /** Hold a place for the customer to confirm. */
  setCandidate: (place: Place) => void;
  clearCandidate: () => void;
  /** Record that the user declined, without a hard error. */
  dismiss: () => void;
}

const PREF_KEY = "deligro-loc-pref"; // "asked" once the user has responded
const CACHE_KEY = "deligro-loc-cache"; // last resolved location

// Accuracy gates for detection. The Geolocation API hands back whatever it has
// first — often a coarse Wi-Fi/cell/IP estimate that lands you in a neighbouring
// city (Bhilai reading as Bilaspur, ~130km off) before GPS has locked. So we
// watch the position, keep the sharpest fix, and stop early once it's good.
const GOOD_ACCURACY_M = 100; // sharp enough — stop waiting and use it
const MAX_ACCURACY_M = 20_000; // coarser than this ≈ IP-level: don't trust the city
const DETECT_TIMEOUT_MS = 12_000; // how long to let the fix sharpen before giving up

/**
 * How long a restored fix is treated as current.
 *
 * The cache used to carry no timestamp at all, so no expiry was even
 * expressible: a fix resolved in another city weeks ago was restored on open
 * and adopted as `status: "granted"`, and every "1.2 km" on every card, the
 * shop sort order, and the header were all measured from it with nothing to say
 * how old it was. Twelve hours is roughly "since you last went out" — long
 * enough that a normal day's use never re-prompts, short enough that a fix does
 * not survive a journey.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CachedPlace {
  label: string | null;
  sublabel: string | null;
  coords: Coords | null;
  /** Absent on a cache written before this field existed — treated as expired. */
  at?: number;
}

function loadCache(): CachedPlace | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedPlace;
  } catch {
    return null;
  }
}

/** Age in ms, or null when the entry predates timestamping (i.e. unknowable). */
function cacheAge(cached: CachedPlace | null): number | null {
  if (!cached || typeof cached.at !== "number") return null;
  return Date.now() - cached.at;
}

function cacheIsFresh(cached: CachedPlace | null): boolean {
  const age = cacheAge(cached);
  return age !== null && age < CACHE_TTL_MS;
}

function saveCache(data: {
  label: string | null;
  sublabel: string | null;
  coords: Coords | null;
}) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ...data, at: Date.now() }),
    );
  } catch {}
}

function markAsked() {
  try {
    localStorage.setItem(PREF_KEY, "asked");
  } catch {}
}

/**
 * Geolocation only works on a secure origin. On plain http (e.g. a phone
 * hitting the dev server over the LAN) `getCurrentPosition` never prompts and
 * fails as PERMISSION_DENIED, which would otherwise look like a user refusal.
 */
function geolocationUnavailable(): string | null {
  if (!("geolocation" in navigator)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return null;
}

/** The device's current answer, before we ask again. Not all browsers expose it. */
async function permissionState(): Promise<PermissionState | null> {
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" });
    return p?.state ?? null;
  } catch {
    return null;
  }
}

export const useLocation = create<LocationState>((set, get) => ({
  // Deligro only delivers in Bemetara today, so that's where we assume the
  // customer is until they tell us otherwise: the header shows it, and every
  // shop distance is measured from it. A detected fix or a saved address
  // replaces it (status flips to "granted"), and distances follow.
  status: "idle",
  label: PINNED_LOCATION.label,
  sublabel: PINNED_LOCATION.sublabel,
  coords: PINNED_LOCATION.coords,
  coordsAgeMs: null,
  error: null,
  askOpen: false,
  blocked: false,
  savedActive: false,
  candidate: null,

  maybePrompt: async () => {
    if (typeof window === "undefined") return;

    // Restore a previously resolved location so the header isn't empty — but
    // only claim it is current while it still is.
    //
    // A stale entry is still shown (an empty header helps nobody, and the last
    // known area is usually right) and is NOT promoted to "granted": `stale`
    // keeps distances rendering while letting the header say where the number
    // came from, and the refresh below replaces it as soon as the device answers.
    const cached = loadCache();
    const fresh = cacheIsFresh(cached);
    if (cached?.coords && !get().savedActive) {
      set({
        status: fresh ? "granted" : "stale",
        label: cached.label ?? null,
        sublabel: cached.sublabel ?? null,
        coords: cached.coords ?? null,
        coordsAgeMs: cacheAge(cached),
      });
    }

    const unavailable = geolocationUnavailable();
    if (unavailable) {
      set({
        status: "unsupported",
        error:
          unavailable === "insecure"
            ? {
                en: "Location needs a secure (https) connection on this device.",
                hi: "इस डिवाइस पर लोकेशन के लिए सुरक्षित (https) कनेक्शन चाहिए।",
              }
            : {
                en: "This device can't share its location.",
                hi: "यह डिवाइस अपनी लोकेशन नहीं बता सकता।",
              },
      });
      return;
    }

    // If the device already said yes, skip the explainer and just refresh the
    // fix — re-asking a granted permission is pure friction.
    const state = await permissionState();
    if (state === "granted") {
      get().detect();
      return;
    }
    if (state === "denied") {
      // The OS won't show its prompt again; only Settings can undo this. Don't
      // pop the sheet on load — the header still shows a fallback place, and the
      // user can reopen it deliberately.
      markAsked();
      set({
        status: "denied",
        blocked: true,
        error: {
          en: "Location is blocked for Deligro in your device settings.",
          hi: "आपके फ़ोन की सेटिंग में Deligro के लिए लोकेशन बंद है।",
        },
      });
      return;
    }

    let alreadyAsked = false;
    try {
      alreadyAsked = localStorage.getItem(PREF_KEY) === "asked";
    } catch {}

    // Show the in-app explainer ONLY when we know the browser hasn't been asked
    // yet ("prompt") — i.e. the user genuinely has no permission. If the
    // Permissions API can't tell us the state (`null`, common on some mobile
    // browsers), don't guess and pop a popup at someone who may already have
    // granted it: detect silently instead. A granted device resolves with no
    // UI at all; only a true first-timer sees the browser's own native prompt.
    // A FRESH cache is answer enough — nothing to ask, nothing to re-detect.
    // A stale one is not: it is why the header may be showing another city, so
    // fall through and let the branches below refresh it.
    if (cached?.coords && fresh) return;

    if (state === "prompt") {
      if (!alreadyAsked) set({ askOpen: true });
      return;
    }

    // state === null (unknown): silent detect — no custom popup.
    if (!alreadyAsked) get().detect();
  },

  openAsk: () => set({ askOpen: true, error: null }),
  closeAsk: () => set({ askOpen: false }),

  detect: () => {
    if (typeof window === "undefined") return;

    const unavailable = geolocationUnavailable();
    if (unavailable) {
      set({
        status: "unsupported",
        error:
          unavailable === "insecure"
            ? {
                en: "Location needs a secure (https) connection on this device.",
                hi: "इस डिवाइस पर लोकेशन के लिए सुरक्षित (https) कनेक्शन चाहिए।",
              }
            : {
                en: "This device can't share its location.",
                hi: "यह डिवाइस अपनी लोकेशन नहीं बता सकता।",
              },
      });
      return;
    }

    markAsked();
    // The sheet stays up while the native prompt is open — closing it here
    // would leave the user staring at the home screen mid-decision.
    set({ status: "loading", error: null, blocked: false });

    // Resolve a fix to a place and store it. Runs after we already have coords.
    const applyFix = async (pos: GeolocationPosition) => {
      const coords: Coords = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };
      // A saved address is the active location: this fix is only a candidate,
      // held for the customer to confirm. Nothing about the header, the
      // distances or the cache changes.
      if (get().savedActive) {
        const found = await reverseGeocode(coords.lat, coords.lng);
        set({
          status: "granted",
          askOpen: false,
          blocked: false,
          error: null,
          candidate: {
            label: found?.label ?? "Current location",
            sublabel: found?.sublabel ?? null,
            coords,
          },
        });
        return;
      }

      // Device said yes — drop the sheet and show what we have immediately.
      set({
        status: "granted",
        coords,
        coordsAgeMs: 0,
        askOpen: false,
        blocked: false,
      });

      const place = await reverseGeocode(coords.lat, coords.lng);
      const next = {
        label: place?.label ?? "Current location",
        sublabel: place?.sublabel ?? null,
        coords,
      };
      saveCache(next);
      set({ ...next, status: "granted", coordsAgeMs: 0 });
    };

    // We watch instead of taking a single shot, because the first reading the
    // device returns is usually a coarse network estimate; GPS sharpens over
    // the next few seconds. We keep the best fix seen and stop as soon as it's
    // good enough (or the timer runs out).
    let best: GeolocationPosition | null = null;
    let settled = false;
    let watchId: number | null = null;

    const stop = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      clearTimeout(timer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      stop();

      if (!best) {
        set({
          status: "idle",
          error: {
            en: "Your device took too long to find you. Try again.",
            hi: "आपकी लोकेशन मिलने में बहुत देर लगी। फिर से कोशिश करें।",
          },
        });
        return;
      }

      if (best.coords.accuracy > MAX_ACCURACY_M) {
        // Only a coarse, network/IP-level guess made it in — this is exactly
        // what dropped the header into the wrong city. Don't overwrite with a
        // place we don't trust; keep whatever we already show and invite the
        // user to set their area by hand.
        set({
          // Keeps whatever we were showing at whatever standing it had: if that
          // was a stale cached fix, a coarse reading is no reason to promote it
          // to "current".
          status: get().coords ? get().status : "idle",
          error: {
            en: "We couldn't pinpoint you accurately. Pick your area for the right shops.",
            hi: "आपकी सही लोकेशन नहीं मिली। सही दुकानों के लिए अपना इलाका चुनें।",
          },
        });
        return;
      }

      void applyFix(best);
    };

    const timer = setTimeout(finish, DETECT_TIMEOUT_MS);

    const onPosition = (pos: GeolocationPosition) => {
      if (settled) return;
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= GOOD_ACCURACY_M) finish();
    };

    const onError = (err: GeolocationPositionError) => {
      // Hold out for the timer if we already have something to fall back on;
      // a late error shouldn't throw away a usable fix.
      if (settled || best) return;
      settled = true;
      stop();

      const denied = err.code === err.PERMISSION_DENIED;
      const timedOut = err.code === err.TIMEOUT;
      set({
        status: denied ? "denied" : "idle",
        blocked: denied,
        // Only surface the popup when they genuinely lack permission — a
        // transient timeout shouldn't throw a sheet in the user's face.
        askOpen: denied,
        error: denied
          ? {
              en: "Location is blocked for Deligro, so your phone won't ask again. Turn it on with the steps below, or pick an address manually.",
              hi: "Deligro के लिए लोकेशन बंद है, इसलिए फ़ोन दोबारा नहीं पूछेगा। नीचे दिए तरीके से चालू करें, या खुद पता चुनें।",
            }
          : timedOut
            ? {
                en: "Your device took too long to find you. Try again.",
                hi: "आपकी लोकेशन मिलने में बहुत देर लगी। फिर से कोशिश करें।",
              }
            : {
                en: "Couldn't get your location. Please try again.",
                hi: "आपकी लोकेशन नहीं मिल पाई। कृपया फिर से कोशिश करें।",
              },
      });
    };

    const options: PositionOptions = {
      enableHighAccuracy: true,
      timeout: DETECT_TIMEOUT_MS,
      maximumAge: 0,
    };

    // Both calls run synchronously inside the caller's tap, which is what lets
    // the browser show its permission prompt. `getCurrentPosition` is the
    // canonical prompt trigger (some WebKit shells — Brave/Chrome on iPhone —
    // are most reliable with it); the watch then keeps sharpening the fix. They
    // share one prompt and feed the same `best`.
    navigator.geolocation.getCurrentPosition(onPosition, onError, options);
    watchId = navigator.geolocation.watchPosition(onPosition, onError, options);
  },

  // A hand-picked address is as good as a detected fix as far as the header is
  // concerned, and it counts as having been asked — we shouldn't nag afterwards.
  setPlace: ({ label, sublabel = null, coords = null }) => {
    markAsked();
    const next = { label, sublabel, coords };
    saveCache(next);
    // Hand-picked, so it is current by definition — the customer just said so.
    set({
      ...next,
      status: "granted",
      coordsAgeMs: 0,
      askOpen: false,
      blocked: false,
      error: null,
    });
  },

  adoptSaved: ({ label, sublabel = null, coords = null }) =>
    set({
      label,
      sublabel,
      coords,
      status: "granted",
      coordsAgeMs: 0,
      savedActive: true,
      candidate: null,
      askOpen: false,
      blocked: false,
      error: null,
    }),

  releaseSaved: () => set({ savedActive: false, candidate: null }),

  setCandidate: (place) => set({ candidate: place }),
  clearCandidate: () => set({ candidate: null }),

  dismiss: () => {
    markAsked();
    set({ askOpen: false, error: null });
  },
}));

/**
 * Forget the person this device was last used by.
 *
 * The place the customer picked is private: a saved address's label, its full
 * line and its coordinates. It is cached in `localStorage` so the header is not
 * empty on a cold start, which is right for the same person and wrong for the
 * next one on a shared phone. Called when a session ends (the sign-out landing)
 * and when a new one starts (a successful sign-in), because either can be the
 * moment the device changes hands.
 *
 * Removes the cached place and puts the in-memory store back on the city
 * default, so a page that is already open cannot re-save it. `PREF_KEY` stays:
 * it only records that the permission explainer has been answered, which says
 * nothing about who answered it.
 */
export function clearLocationCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
  useLocation.setState({
    status: "idle",
    label: PINNED_LOCATION.label,
    sublabel: PINNED_LOCATION.sublabel,
    coords: PINNED_LOCATION.coords,
    coordsAgeMs: null,
    error: null,
    askOpen: false,
    blocked: false,
    savedActive: false,
    candidate: null,
  });
}
