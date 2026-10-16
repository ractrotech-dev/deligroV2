"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Wraps a screen whose artwork runs edge to edge under the status bar.
 *
 * The `immersive` class is what globals.css keys off: the scroller drops the
 * strip it normally reserves, so the hero starts at y=0 and the status bar
 * floats on a scrim over the photo rather than sitting on a panel above it.
 *
 * Once the hero has scrolled past, `is-scrolled` hands the status bar its solid
 * background back — white icons over a light menu would be unreadable.
 */
export function ImmersiveScreen({
  children,
  threshold = 140,
}: Readonly<{
  children: React.ReactNode;
  /** Scroll distance, in px, after which the status bar goes solid. */
  threshold?: number;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // The screen scrolls inside `.app-scroll` (the phone shell), not the window.
  useEffect(() => {
    const scroller = ref.current?.closest(".app-scroll");
    if (!scroller) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrolled(scroller.scrollTop > threshold);
      });
    };

    onScroll(); // a restored scroll position should start solid
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [threshold]);

  return (
    <div ref={ref} className={`immersive${scrolled ? " is-scrolled" : ""}`}>
      {children}
    </div>
  );
}
