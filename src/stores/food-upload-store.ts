"use client";

import { create } from "zustand";
import { shrinkForUpload } from "@/lib/images/shrink";

/**
 * The background queue behind Admin → Storage → "Upload a folder".
 *
 * It lives in a module-level store rather than in the page for one reason: an
 * operator who drops a folder of two hundred photos in should be able to walk
 * off and do something else. The store keeps running while they browse vendors
 * or read a report — `FoodUploadDock`, mounted once in the admin layout, is
 * only a window onto it, and unmounting the page it started from changes
 * nothing.
 *
 * What it does NOT survive is a full page load, because a `File` handle cannot
 * be persisted; the dock puts up a beforeunload guard while work is in flight.
 *
 * Each photo is a separate POST to the same route the single upload uses. That
 * is deliberate — one endpoint, one set of checks (AGENTS.md §3/§5/§6), and
 * per-file progress and per-file errors come out of it for free. Concurrency is
 * held at three: enough to keep the pipe full, low enough that the endpoint's
 * own rate limit is a backstop rather than a wall.
 */

const ENDPOINT = "/api/admin/food-images";
const CONCURRENCY = 3;
/** Transient failures worth another go (network blips, a 5xx). */
const MAX_ATTEMPTS = 3;

type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  | "duplicate"
  | "failed"
  | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  title: string;
  tags: string[];
  status: UploadStatus;
  error?: string;
  attempts: number;
}

interface QueuedPhoto {
  file: File;
  title: string;
  tags: string[];
}

interface FoodUploadState {
  items: UploadItem[];
  paused: boolean;
  collapsed: boolean;
  /** Bumped on cancel, so results from an abandoned batch are ignored. */
  generation: number;
  active: number;
  /** Set when a batch drains — the dock refreshes the route off this. */
  finishedAt: number;

  enqueue: (photos: QueuedPhoto[]) => void;
  pause: () => void;
  resume: () => void;
  cancelRemaining: () => void;
  retryFailed: () => void;
  dismiss: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

/** In-flight requests, so cancel actually stops the bytes. */
const inFlight = new Map<string, AbortController>();
/** Set by a 429: nothing new is dispatched until the window the server named. */
let throttledUntil = 0;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

export const useFoodUpload = create<FoodUploadState>((set, get) => {
  /** Settle one item, free its slot, and let the next one in. */
  function settle(id: string, patch: Partial<UploadItem>) {
    inFlight.delete(id);
    set((s) => ({
      active: Math.max(0, s.active - 1),
      items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
    pump();
  }

  /** Put an item back in line without consuming its slot's progress. */
  function requeue(id: string, attempts: number) {
    inFlight.delete(id);
    set((s) => ({
      active: Math.max(0, s.active - 1),
      items: s.items.map((i) =>
        i.id === id ? { ...i, status: "queued", attempts } : i
      ),
    }));
    pump();
  }

  function markFinishedIfDrained() {
    const s = get();
    if (s.items.length === 0) return;
    const busy = s.items.some(
      (i) => i.status === "queued" || i.status === "uploading"
    );
    if (!busy && s.active === 0 && s.finishedAt === 0) {
      set({ finishedAt: Date.now() });
    }
  }

  async function upload(item: UploadItem, generation: number) {
    const controller = new AbortController();
    inFlight.set(item.id, controller);

    try {
      // Shrink first: a 6 MB camera photo is refused by the bucket, and the
      // operator has no way to fix two hundred of those by hand.
      const file = await shrinkForUpload(item.file);
      if (get().generation !== generation) {
        settle(item.id, { status: "cancelled" });
        return;
      }

      const body = new FormData();
      body.set("file", file);
      body.set("title", item.title);
      body.set("tags", item.tags.join(", "));
      // Left empty on purpose — the server reads veg/non-veg off the name and
      // the folder tags, with the same rules a single upload uses.
      body.set("veg", "");

      const res = await fetch(ENDPOINT, {
        method: "POST",
        body,
        signal: controller.signal,
      });

      if (get().generation !== generation) {
        settle(item.id, { status: "cancelled" });
        return;
      }

      if (res.status === 429) {
        const wait = Math.min(
          60,
          Math.max(2, Number(res.headers.get("Retry-After")) || 5)
        );
        throttledUntil = Date.now() + wait * 1000;
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            pump();
          }, wait * 1000 + 250);
        }
        // Not an attempt: the server asked us to slow down, not to give up.
        requeue(item.id, item.attempts);
        return;
      }

      // A signed-out session redirects to the login page, which arrives as
      // HTML with a 200. Read it as the auth failure it is rather than as a
      // malformed photo.
      const payload = (await res.json().catch(() => null)) as
        | { image?: unknown; message?: string; error?: string }
        | null;

      if (res.ok && payload?.image) {
        settle(item.id, { status: "done" });
        return;
      }

      if (!payload) {
        settle(item.id, {
          status: "failed",
          error: "Signed out, or the server replied with something unexpected.",
        });
        return;
      }

      if (res.status === 409 || payload.error === "duplicate_title") {
        settle(item.id, { status: "duplicate" });
        return;
      }

      if (res.status >= 500 && item.attempts + 1 < MAX_ATTEMPTS) {
        requeue(item.id, item.attempts + 1);
        return;
      }

      settle(item.id, {
        status: "failed",
        error: payload.message ?? errorText(payload.error, res.status),
        attempts: item.attempts + 1,
      });
    } catch (err) {
      settleThrown(item, generation, err);
    } finally {
      markFinishedIfDrained();
    }
  }

  /** An upload that threw: cancelled, aborted, worth another try, or failed. */
  function settleThrown(item: UploadItem, generation: number, err: unknown) {
    if (get().generation !== generation) {
      settle(item.id, { status: "cancelled" });
      return;
    }
    if ((err as Error)?.name === "AbortError") {
      settle(item.id, { status: "cancelled" });
      return;
    }
    if (item.attempts + 1 < MAX_ATTEMPTS) {
      requeue(item.id, item.attempts + 1);
      return;
    }
    settle(item.id, {
      status: "failed",
      error: "Upload failed — check your connection.",
      attempts: item.attempts + 1,
    });
  }

  /** Claim as many queued items as there are free slots and start them. */
  function pump() {
    const s = get();
    if (s.paused) return;

    if (Date.now() < throttledUntil) {
      if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          pump();
        }, throttledUntil - Date.now() + 250);
      }
      return;
    }

    const free = CONCURRENCY - s.active;
    if (free <= 0) return;

    const claimed = s.items.filter((i) => i.status === "queued").slice(0, free);
    if (claimed.length === 0) {
      markFinishedIfDrained();
      return;
    }

    const ids = new Set(claimed.map((i) => i.id));
    set({
      active: s.active + claimed.length,
      items: s.items.map((i) =>
        ids.has(i.id) ? { ...i, status: "uploading" as const } : i
      ),
    });
    for (const item of claimed) void upload(item, s.generation);
  }

  return {
    items: [],
    paused: false,
    collapsed: false,
    generation: 0,
    active: 0,
    finishedAt: 0,

    enqueue: (photos) => {
      if (photos.length === 0) return;
      const items: UploadItem[] = photos.map((p) => ({
        id: `u${++seq}`,
        file: p.file,
        title: p.title,
        tags: p.tags,
        status: "queued",
        attempts: 0,
      }));
      set((s) => ({
        // A batch started while an older one is still on screen replaces the
        // settled rows and keeps anything still moving.
        items: [
          ...s.items.filter(
            (i) => i.status === "queued" || i.status === "uploading"
          ),
          ...items,
        ],
        paused: false,
        collapsed: false,
        finishedAt: 0,
      }));
      pump();
    },

    pause: () => set({ paused: true }),

    resume: () => {
      set({ paused: false });
      pump();
    },

    cancelRemaining: () => {
      set((s) => ({
        generation: s.generation + 1,
        paused: false,
        items: s.items.map((i) =>
          i.status === "queued" ? { ...i, status: "cancelled" as const } : i
        ),
      }));
      for (const controller of inFlight.values()) controller.abort();
      markFinishedIfDrained();
    },

    retryFailed: () => {
      set((s) => ({
        finishedAt: 0,
        items: s.items.map((i) =>
          i.status === "failed" || i.status === "cancelled"
            ? { ...i, status: "queued" as const, attempts: 0, error: undefined }
            : i
        ),
      }));
      pump();
    },

    dismiss: () => {
      get().cancelRemaining();
      set({ items: [], active: 0, finishedAt: 0, paused: false });
    },

    setCollapsed: (collapsed) => set({ collapsed }),
  };
});

function errorText(code: string | undefined, status: number): string {
  switch (code) {
    case "invalid_type":
      return "Not a JPG, PNG or WebP.";
    case "too_large":
      return "Still over 2 MB after shrinking.";
    case "title_required":
      return "This photo has no name.";
    case "backend_not_configured":
      return "Storage is not connected.";
    default:
      return `Upload failed (${status}).`;
  }
}

/** Batch totals, for the dock and the page's summary line. */
export function summarise(items: UploadItem[]) {
  let done = 0;
  let duplicate = 0;
  let failed = 0;
  let cancelled = 0;
  let pending = 0;
  for (const i of items) {
    if (i.status === "done") done++;
    else if (i.status === "duplicate") duplicate++;
    else if (i.status === "failed") failed++;
    else if (i.status === "cancelled") cancelled++;
    else pending++;
  }
  return {
    total: items.length,
    done,
    duplicate,
    failed,
    cancelled,
    pending,
    settled: items.length - pending,
    running: pending > 0,
  };
}
