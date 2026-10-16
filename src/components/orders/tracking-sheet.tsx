"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/**
 * Where the sheet's top edge can come to rest, as a fraction of the stage it is
 * dragged inside. Listed top-first, which is the order `nearestSnap` assumes.
 *
 * The last entry is load-bearing beyond the gesture: the tracking screen sizes
 * the map to exactly that fraction, so the sheet at its lowest rest position
 * meets the bottom of the map. Dragging down can then never expose the page
 * behind the two of them — which was the grey band under "Get help with this
 * order", where the sheet simply stopped and the shell's background showed
 * through with the sheet's drop shadow smeared over it.
 */
export const SHEET_SNAPS = [0.08, 0.34, 0.66] as const;

/** Open at the middle stop: some map, and the status without scrolling. */
export const SHEET_DEFAULT_SNAP = 1;

/** The one the map's height is measured against — see `SHEET_SNAPS`. */
export const SHEET_COLLAPSED_SNAP = SHEET_SNAPS.length - 1;

/** A flick this far commits to the next stop regardless of where it landed. */
const FLICK_PX = 44;

/** Past this, a press is a drag and not a tap on the handle. */
const TAP_SLOP = 5;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * A bottom sheet you can actually drag.
 *
 * The tracking screen has always *looked* like one — rounded top, a grab
 * handle, a map behind it — while being an ordinary block in a scrolling page,
 * so the handle was decoration for a gesture that did nothing. This moves the
 * sheet between the stops in `SHEET_SNAPS` and lets its contents scroll on
 * their own underneath, which is what the handle was promising.
 *
 * Two gestures reach it. Dragging the handle is the obvious one and works with
 * a mouse, a finger or a keyboard. The second is the one people actually try:
 * a finger anywhere in the content. That is claimed only when the pull cannot
 * mean anything else — the list is already at its top and the finger is going
 * down, or the sheet is not fully open and the finger is going up — so an
 * ordinary scroll is never stolen. It needs a non-passive `touchmove` to
 * suppress the native scroll, hence the listener wiring rather than React's
 * (passive) `onTouchMove`.
 */
export function TrackingSheet({
  stageHeight,
  children,
  header,
  initialSnap = SHEET_DEFAULT_SNAP,
  onRestTop,
}: Readonly<{
  /**
   * Height of the area the sheet is dragged inside, in px. 0 before the parent
   * has measured it — server-rendered, most of all — and the sheet positions
   * itself as a percentage of its own (stage-sized) box until then, so the
   * first paint already lands on the right stop instead of flashing open.
   */
  stageHeight: number;
  children: React.ReactNode;
  /**
   * Rendered under the handle and outside the scroller, so it is on screen at
   * every stop and never scrolls away. For the one thing on this screen that
   * has to be readable the moment it is needed rather than found: the delivery
   * code, at the door, one-handed.
   */
  header?: React.ReactNode;
  initialSnap?: number;
  /**
   * Called with the sheet's top edge whenever it comes to rest, never during a
   * drag. The map uses it to keep its pins out from under the sheet; a
   * per-frame callback would re-render the map's parent sixty times a second
   * to do it.
   */
  onRestTop?: (top: number) => void;
}>) {
  const t = useT();
  const snapTops = useMemo(
    () => SHEET_SNAPS.map((f) => Math.round(stageHeight * f)),
    [stageHeight],
  );
  const measured = stageHeight > 0;

  const [snap, setSnap] = useState(initialSnap);
  /**
   * The live position, in px, while a finger or a mouse is on the sheet — and
   * null the rest of the time, when the position is simply the stop the sheet
   * is on. Keeping "at rest" derived rather than stored is what makes a resize
   * correct for free: new stage, new stop, no state to re-seat.
   */
  const [dragTop, setDragTop] = useState<number | null>(null);

  const restTop = snapTops[clamp(snap, 0, snapTops.length - 1)];
  const top = dragTop ?? restTop;

  // The touch listeners below are attached once and outlive any particular
  // render, so they read the current position and stops through refs rather
  // than through the closure they were created in.
  const liveTop = useRef(top);
  const liveTops = useRef(snapTops);
  useEffect(() => {
    liveTop.current = top;
    liveTops.current = snapTops;
  }, [top, snapTops]);

  /** Come to rest on `index`, clamped to the stops that exist. */
  const goTo = useCallback((index: number) => {
    setSnap(clamp(index, 0, SHEET_SNAPS.length - 1));
    setDragTop(null);
  }, []);

  /** The stop a released drag belongs to: direction first, distance second. */
  const settle = useCallback(
    (from: number, delta: number) => {
      const tops = liveTops.current;
      if (Math.abs(delta) >= FLICK_PX) {
        goTo(snap + (delta > 0 ? 1 : -1));
        return;
      }
      let nearest = 0;
      for (let i = 1; i < tops.length; i++) {
        if (Math.abs(tops[i] - from) < Math.abs(tops[nearest] - from))
          nearest = i;
      }
      goTo(nearest);
    },
    [goTo, snap],
  );

  useEffect(() => {
    if (!measured) return;
    onRestTop?.(restTop);
  }, [measured, restTop, onRestTop]);

  /* ---------- the handle ---------- */

  const grab = useRef<{ y: number; top: number; moved: boolean } | null>(null);
  // A drag that ends over the handle still fires a click. Remembered here so
  // the tap-to-toggle below doesn't undo the drag the user just made.
  const wasDrag = useRef(false);

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!measured) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { y: e.clientY, top, moved: false };
    wasDrag.current = false;
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const g = grab.current;
    if (!g) return;
    const dy = e.clientY - g.y;
    if (Math.abs(dy) > TAP_SLOP) g.moved = true;
    setDragTop(clamp(g.top + dy, snapTops[0], snapTops[snapTops.length - 1]));
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const g = grab.current;
    grab.current = null;
    if (!g) return;
    if (!g.moved) {
      setDragTop(null); // a tap — the click handler owns where it goes
      return;
    }
    wasDrag.current = true;
    const dy = e.clientY - g.y;
    settle(clamp(g.top + dy, snapTops[0], snapTops[snapTops.length - 1]), dy);
  }

  function onHandleClick() {
    if (wasDrag.current) {
      wasDrag.current = false;
      return;
    }
    // Tapping the handle walks up, then wraps back to the bottom stop — the
    // whole range is reachable without a gesture, which is also what the
    // keyboard gets for free.
    goTo(snap === 0 ? SHEET_COLLAPSED_SNAP : snap - 1);
  }

  function onHandleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      goTo(snap - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      goTo(snap + 1);
    }
  }

  /* ---------- pulling on the content ---------- */

  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !measured) return;

    let startY = 0;
    let startTop = 0;
    let active = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      startTop = liveTop.current;
      active = false;
    };

    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const tops = liveTops.current;
      const dy = e.touches[0].clientY - startY;
      if (!active) {
        const pullingDownAtTop = dy > TAP_SLOP && el.scrollTop <= 0;
        const pullingUpNotOpen = dy < -TAP_SLOP && liveTop.current > tops[0];
        if (!pullingDownAtTop && !pullingUpNotOpen) return;
        active = true;
        startY = e.touches[0].clientY;
        startTop = liveTop.current;
      }
      // Non-passive on purpose: this is the only way to stop the browser
      // scrolling the list at the same time as we move the sheet.
      e.preventDefault();
      setDragTop(
        clamp(
          startTop + (e.touches[0].clientY - startY),
          tops[0],
          tops[tops.length - 1],
        ),
      );
    };

    const onEnd = () => {
      if (!active) return;
      active = false;
      settle(liveTop.current, liveTop.current - startTop);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [measured, settle]);

  /* ---------- render ---------- */

  // Percentages of the sheet's own box — which is the stage — until the stage
  // has been measured. Same position, no layout knowledge required, so the
  // server-rendered frame is already correct.
  const offset = measured
    ? `${top}px`
    : `${SHEET_SNAPS[clamp(initialSnap, 0, SHEET_SNAPS.length - 1)] * 100}%`;

  return (
    <div
      className={cn(
        "bolt-sheet absolute inset-x-0 top-0 flex h-full flex-col",
        dragTop === null &&
          "transition-transform duration-300 ease-out motion-reduce:transition-none",
      )}
      style={{ transform: `translate3d(0, ${offset}, 0)` }}
    >
      <button
        type="button"
        aria-label={
          snap === 0
            ? t("Collapse order details", "ऑर्डर की जानकारी छोटी करें")
            : t("Expand order details", "ऑर्डर की जानकारी बड़ी करें")
        }
        aria-expanded={snap === 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onHandleClick}
        onKeyDown={onHandleKeyDown}
        className="flex h-8 w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
      >
        <span className="h-1 w-9 rounded-full bg-line" />
      </button>

      {header ? <div className="shrink-0">{header}</div> : null}

      <div
        ref={scroller}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {/* The tab bar floats over the bottom of the shell, so the last control
            clears it here rather than ending underneath it. */}
        <div className="pb-[calc(var(--tabbar-h)+1rem)]">{children}</div>
        {/* The sheet's box is the full stage and is pushed down out of view, so
            the far end of the scroller sits below the screen. This gives the
            scroll the same distance back, and the last row stops exactly at the
            bottom edge instead of below it. */}
        <div aria-hidden style={{ height: measured ? top : 0 }} />
      </div>
    </div>
  );
}
