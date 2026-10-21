"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellOff,
  Check,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  Phone,
  Store,
  X,
} from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Empty, StatusText } from "@/components/admin/console";
import { decideExceptionAction, listExceptionQueue } from "@/app/manager/actions";
import { playAlertSound } from "@/lib/alerts/tones";
import { exceptionLabel, type ExceptionDecision } from "@/lib/rider/exception-rules";
import type { OpsException } from "@/lib/data-access/delivery-exceptions";
import { cn } from "@/lib/utils/cn";

/**
 * "Needs a decision" — the riders' exceptions waiting on ops, oldest first,
 * shared by the manager board and the admin live board.
 *
 * Requests (customer unreachable, complete without the code, …) get Approve
 * and Reject, with an optional note the rider sees; reports (missing items,
 * shop delay, …) get Acknowledge. What an approval does is the server's
 * (`decideExceptionAction` → `decideException`); this only asks.
 *
 * Fed two ways: the manager page re-renders it every few seconds through its
 * own AutoRefresh, so `items` simply changes; the admin home does not refresh,
 * so it passes `poll` and this reads the queue itself.
 *
 * ## The sound
 *
 * A rider standing at a locked gate is waiting on this list, so a new arrival
 * is announced with the "alarm" tone. Browsers only start audio after a tap, so
 * the operator turns it on once per device (remembered in localStorage); the
 * off state is visible, never silent-looking-armed. Phones also get the ring
 * push (`ops:<exceptionId>`) whether or not this page is open.
 *
 * ## Console rules
 *
 * Tokens only — no raw palette colours, no `dark:` — so it reads in the
 * phone frame (`data-theme`) and in the console (`data-console`) alike, and it
 * sizes against its container (`@3xl:`), never the window.
 */

const SOUND_KEY = "deligro-ops-exception-sound";
const POLL_MS = 8_000;

const soundListeners = new Set<() => void>();
function subscribeSound(cb: () => void): () => void {
  soundListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    soundListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function soundSnapshot(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}
function subscribeNever(): () => void {
  return () => {};
}
function audioSupported(): boolean {
  return typeof window.AudioContext !== "undefined";
}
function writeSound(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* private mode: the toggle still applies to this tab */
  }
  for (const cb of soundListeners) cb();
}

export function ExceptionQueue({
  items: initial,
  poll = false,
  className,
}: Readonly<{
  items: OpsException[];
  /** Read the queue every few seconds (a page that does not refresh itself). */
  poll?: boolean;
  className?: string;
}>) {
  const [items, setItems] = useState(initial);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const router = useRouter();

  // New props from the page's own refresh replace the list.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setItems(initial);
  }

  useEffect(() => {
    if (!poll) return;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await listExceptionQueue();
        if (!stopped) setItems(next);
      } catch {
        // A missed poll is the next poll's job.
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [poll]);

  const visible = items.filter((x) => !hidden.has(x.id));
  const sound = useArrivalSound(visible.map((x) => x.id));

  // Every refresh signs each photo afresh, and a new token in `src` would
  // reload a proof photo (up to 5 MB) every few seconds. So the thumbnail
  // keeps the first URL it was shown with — the browser already holds that
  // image — and only takes a newer one if it fails to load. The link to the
  // full photo always uses the newest URL, which is the one still valid.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const unseen = visible.filter((x) => x.photoUrl && !thumbs[x.id]);
  if (unseen.length > 0) {
    setThumbs((t) => {
      const next = { ...t };
      for (const x of unseen) next[x.id] = x.photoUrl as string;
      return next;
    });
  }
  const refreshThumb = useCallback(
    (id: string, url: string | null) => {
      if (url) setThumbs((t) => (t[id] === url ? t : { ...t, [id]: url }));
    },
    []
  );

  const onDecided = useCallback(
    (id: string) => {
      setHidden((h) => new Set(h).add(id));
      router.refresh();
    },
    [router]
  );

  const requests = visible.filter((x) => x.family === "request").length;

  return (
    <section className={cn("@container", className)} aria-labelledby="ops-exceptions-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 id="ops-exceptions-title" className="text-[15px] font-bold text-ink">
            Needs a decision
          </h2>
          <span className="text-xs font-medium text-muted">
            {visible.length === 0
              ? "nothing waiting"
              : `${visible.length} waiting${requests ? ` · ${requests} request${requests === 1 ? "" : "s"}` : ""}`}
          </span>
        </div>
        {sound.supported ? (
          <button
            type="button"
            onClick={sound.on ? sound.disarm : sound.arm}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2"
            aria-pressed={sound.on}
          >
            {sound.on ? <Bell className="size-3.5 text-accent" /> : <BellOff className="size-3.5 text-muted" />}
            {sound.on ? "Sound on" : "Sound off"}
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <Empty className="mt-2.5">No rider is waiting on ops right now.</Empty>
      ) : (
        <ul className="mt-2.5 grid gap-2.5 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {visible.map((x) => (
            <ExceptionCard
              key={x.id}
              item={x}
              thumbUrl={thumbs[x.id] ?? x.photoUrl}
              onThumbError={() => refreshThumb(x.id, x.photoUrl)}
              onDecided={onDecided}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExceptionCard({
  item: x,
  thumbUrl,
  onThumbError,
  onDecided,
}: Readonly<{
  item: OpsException;
  thumbUrl: string | null;
  onThumbError: () => void;
  onDecided: (id: string) => void;
}>) {
  const photoUrl = x.photoUrl;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const request = x.family === "request";
  const late = x.minutesWaiting >= 5;

  const decide = (decision: ExceptionDecision) => {
    startTransition(async () => {
      setError(null);
      const result = await decideExceptionAction(x.id, decision, note.trim() || undefined);
      if (!result.ok) {
        setError(result.error ?? "That didn't go through.");
        // Gone from under us: drop it, the next refresh agrees.
        if (/already resolved|no longer exists/i.test(result.error ?? "")) onDecided(x.id);
        return;
      }
      if (result.orderCancelled === false) {
        setNotice("Delivery failed, but the order is not cancelled yet — cancel it from Orders.");
        return;
      }
      onDecided(x.id);
    });
  };

  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-ink">{exceptionLabel(x.kind)}</p>
          <p className="mt-0.5 text-xs text-muted">
            <span className="text-data font-semibold text-ink">{x.orderCode}</span>
            {" · "}
            {x.riderName}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <StatusText tone={late ? "red" : "amber"}>{x.minutesWaiting} min</StatusText>
          <p className="mt-0.5 text-[11px] text-muted">{request ? "Request" : "Report"}</p>
        </div>
      </div>

      <div className="mt-2 flex gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">“{x.reason}”</p>
          {x.notes ? <p className="mt-1 text-xs text-muted">{x.notes}</p> : null}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
            {x.shopName ? (
              <span className="inline-flex items-center gap-1">
                <Store className="size-3" />
                {x.shopName}
              </span>
            ) : null}
            {x.customerArea ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" />
                {x.customerArea}
              </span>
            ) : null}
            {x.active ? null : <StatusText tone="neutral">Job no longer active</StatusText>}
          </p>
        </div>
        {photoUrl ? (
          <a
            href={photoUrl}
            target="_blank"
            rel="noreferrer"
            className="block size-16 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2"
            aria-label={`Photo from the rider for ${x.orderCode}`}
          >
            {/* A plain <img>: the URL is a 10-minute signed link to a private
                proof photo, which the image optimiser must not fetch or cache. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbUrl ?? photoUrl}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
              onError={onThumbError}
            />
          </a>
        ) : null}
      </div>

      {request ? (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="Note to the rider (optional)"
          aria-label={`Note to the rider about ${x.orderCode}`}
          className="mt-2.5 h-9 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-ink placeholder:text-muted"
        />
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {request ? (
          <>
            <Button size="sm" onClick={() => decide("approve")} disabled={pending} className="h-9">
              {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide("reject")} disabled={pending} className="h-9">
              <X className="size-4" />
              Reject
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => decide("acknowledge")} disabled={pending} className="h-9">
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
            Acknowledge
          </Button>
        )}
        {x.riderPhone ? (
          <a href={`tel:${x.riderPhone}`} className={buttonClasses({ variant: "ghost", size: "sm", className: "h-9" })}>
            <Phone className="size-4" />
            Call rider
          </a>
        ) : null}
        {photoUrl ? null : x.kind === "complete_without_code" ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">
            <ImageIcon className="size-3" />
            No photo yet
          </span>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-[12.5px] font-medium text-deal">{error}</p> : null}
      {notice ? <p className="mt-2 text-[12.5px] font-medium text-ink">{notice}</p> : null}
    </li>
  );
}

/** The alarm tone on each new arrival, once armed. */
function useArrivalSound(ids: string[]) {
  const on = useSyncExternalStore(subscribeSound, soundSnapshot, () => false);
  const supported = useSyncExternalStore(subscribeNever, audioSupported, () => true);
  const audio = useRef<AudioContext | null>(null);
  const announced = useRef<Set<string> | null>(null);
  const key = ids.join(",");

  useEffect(() => {
    const current = key ? key.split(",") : [];
    // First look (or just armed): adopt what is there without sounding it.
    if (!announced.current) {
      announced.current = new Set(current);
      return;
    }
    const fresh = current.filter((id) => !announced.current?.has(id));
    announced.current = new Set(current);
    if (!on || fresh.length === 0) return;
    const ctx = audio.current ?? (typeof window.AudioContext !== "undefined" ? new AudioContext() : null);
    audio.current = ctx;
    if (ctx) {
      void ctx
        .resume()
        .then(() => playAlertSound(ctx, "alarm"))
        .catch(() => {});
    }
    navigator.vibrate?.([200, 100, 200]);
  }, [key, on]);

  const arm = async () => {
    try {
      const ctx = audio.current ?? new AudioContext();
      audio.current = ctx;
      await ctx.resume();
      // Out loud once, so the operator learns the volume works now.
      playAlertSound(ctx, "alarm");
      writeSound(true);
    } catch {
      writeSound(false);
    }
  };
  const disarm = () => writeSound(false);

  return { on, supported, arm, disarm };
}
