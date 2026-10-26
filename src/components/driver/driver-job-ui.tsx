"use client";

import { useId } from "react";
import {
  AlertTriangle,
  Banknote,
  Check,
  House,
  LocateFixed,
  LocateOff,
  Package,
  ShieldCheck,
  Store,
} from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { DriverPayment } from "@/lib/data-access/driver-orders";

type Pt = { lat: number; lng: number };

/**
 * A route panel drawn from coordinates the board already has.
 *
 * This replaces the static Google map picture on the job card. That picture was
 * fetched from Google with an API key, only when the stop had an exact pin, and
 * showed a gap or a broken image whenever either was missing — on a screen a
 * rider looks at one-handed. This is vector: it needs no key, no network and no
 * tiles, so it cannot fail to load. It is a straight-line sketch of where the
 * two ends are, not a road route, and says so. Navigate hands off to Google
 * Maps for the real thing.
 *
 * Renders nothing unless it has two points to join.
 */
export function RoutePanel({
  from,
  to,
  fromKind,
  toKind,
  height = 170,
  children,
}: Readonly<{
  from: Pt | null | undefined;
  to: Pt | null | undefined;
  /** "rider" is a live dot; "shop" and "home" are pins. */
  fromKind: "rider" | "shop";
  toKind: "shop" | "home";
  height?: number;
  /** Chips laid over the top of the panel. */
  children?: React.ReactNode;
}>) {
  const gridId = useId().replace(/:/g, "");
  if (!from || !to) return null;

  const W = 300;
  const H = height;
  const pad = 40;

  // Equirectangular is plenty at city scale: longitude shrinks by cos(lat).
  const k = Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const pts = [from, to].map((p) => ({ x: p.lng * k, y: -p.lat }));
  // A floor on the span so two stops a few metres apart don't blow up the scale.
  const floor = 0.002;
  const minX = Math.min(pts[0].x, pts[1].x);
  const minY = Math.min(pts[0].y, pts[1].y);
  const spanX = Math.max(Math.abs(pts[0].x - pts[1].x), floor);
  const spanY = Math.max(Math.abs(pts[0].y - pts[1].y), floor);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const [a, b] = pts.map((p) => ({
    x: offX + (p.x - minX) * scale,
    y: offY + (p.y - minY) * scale,
  }));

  return (
    <div
      className="relative overflow-hidden rounded-3xl bg-[#10161d]"
      style={{ height }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        className="block size-full"
        aria-hidden
      >
        <defs>
          <pattern
            id={gridId}
            width="60"
            height="46"
            patternUnits="userSpaceOnUse"
          >
            <rect width="60" height="46" fill="#10161d" />
            <rect x="6" y="6" width="48" height="34" rx="6" fill="#151d26" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill={`url(#${gridId})`} />
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="#ff8a2a"
          strokeWidth="9"
          strokeLinecap="round"
          opacity="0.18"
        />
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="#ff8a2a"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <Marker x={a.x} y={a.y} kind={fromKind} />
        <Marker x={b.x} y={b.y} kind={toKind} />
      </svg>
      <p className="absolute bottom-2.5 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white/80">
        Straight line, not the road. Tap Navigate for directions.
      </p>
      {children ? (
        <div className="absolute inset-x-3 top-3 flex items-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Marker({
  x,
  y,
  kind,
}: Readonly<{
  x: number;
  y: number;
  kind: "rider" | "shop" | "home";
}>) {
  if (kind === "rider") {
    return (
      <g>
        <circle cx={x} cy={y} r="15" fill="#4da3ff" opacity="0.25" />
        <circle cx={x} cy={y} r="7" fill="#4da3ff" stroke="#fff" strokeWidth="2" />
      </g>
    );
  }
  const Icon = kind === "shop" ? Store : House;
  return (
    <g>
      <circle
        cx={x}
        cy={y}
        r="15"
        fill={kind === "shop" ? "#ffffff" : "#46c98b"}
      />
      <Icon
        x={x - 8}
        y={y - 8}
        width={16}
        height={16}
        color={kind === "shop" ? "#10161d" : "#06150d"}
        strokeWidth={2.2}
      />
    </g>
  );
}

/** Where the rider has got to: shop, bag, home. */
export function StepTrack({ leg }: Readonly<{ leg: "TO_PICKUP" | "TO_CUSTOMER" }>) {
  const steps = [
    { Icon: Store, label: "Shop" },
    { Icon: Package, label: "Picked up" },
    { Icon: House, label: "Customer" },
  ];
  // Index of the step the rider is working on. Everything before it is done.
  const current = leg === "TO_PICKUP" ? 0 : 2;
  return (
    <ol className="flex items-center" aria-label="Delivery progress">
      {steps.map(({ Icon, label }, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <li
            key={label}
            className={cn("flex items-center", i < steps.length - 1 && "flex-1")}
            aria-current={on ? "step" : undefined}
          >
            <span
              title={label}
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full border-2",
                done && "border-green bg-green text-white",
                on && "border-accent bg-accent-soft text-accent",
                !done && !on && "border-line bg-surface-2 text-muted"
              )}
            >
              {done ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : (
                <Icon className="size-3.5" strokeWidth={2.2} />
              )}
            </span>
            {i < steps.length - 1 ? (
              <span
                className={cn(
                  "mx-1.5 h-0.5 flex-1 rounded-full",
                  done ? "bg-green" : "bg-line"
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Money at the door, said once and loudly. `compact` is the reminder on the way
 * to the shop; the full box is the one the rider reads standing at the gate.
 */
export function CashNotice({
  payment,
  compact,
}: Readonly<{
  payment: DriverPayment;
  compact?: boolean;
}>) {
  if (payment.instruction === "collect") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-2xl border-2 border-deal bg-deal-soft",
          compact ? "px-3.5 py-2.5" : "px-4 py-3.5"
        )}
      >
        <Banknote
          className={cn("shrink-0 text-deal", compact ? "size-5" : "size-7")}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-deal">
            {compact
              ? "You will collect cash at the door"
              : "Collect cash before handing over"}
          </p>
          <p
            className={cn(
              "text-data font-extrabold leading-none text-deal",
              compact ? "mt-1 text-xl" : "mt-1.5 text-[32px]"
            )}
          >
            {formatINR(payment.collectAmount)}
          </p>
        </div>
      </div>
    );
  }
  if (payment.instruction === "prepaid") {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-green bg-green-soft px-3.5 py-3">
        <ShieldCheck className="size-5 shrink-0 text-green" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-green">
            Prepaid, collect nothing
          </p>
          {compact ? null : (
            <p className="text-xs text-muted">
              Already paid online. Do not ask for money.
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-accent bg-accent-soft px-3.5 py-3">
      <AlertTriangle className="size-5 shrink-0 text-accent" />
      <div className="min-w-0">
        <p className="text-sm font-bold text-accent">Payment not confirmed</p>
        {compact ? null : (
          <p className="text-xs text-muted">
            Placed as an online payment that hasn&apos;t settled. Don&apos;t
            collect cash. Check with support before handing over.
          </p>
        )}
      </div>
    </div>
  );
}

/** Why the rider isn't being shown, for each state that isn't sharing. */
const NOT_SHARING_LABEL: Record<"off" | "denied" | "unavailable", string> = {
  denied: "Location off, customer sees an estimate",
  unavailable: "Can't share location",
  off: "Not sharing location",
};

/** Whether the customer can see the rider, as a chip for the route panel. */
export function SharingChip({
  state,
}: Readonly<{
  state: "off" | "starting" | "reporting" | "denied" | "unavailable";
}>) {
  const base =
    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold";
  if (state === "reporting") {
    return (
      <span className={cn(base, "border-white/10 bg-black/60 text-[#46c98b]")}>
        <LocateFixed className="size-3.5" /> Sharing location
      </span>
    );
  }
  if (state === "starting") {
    return (
      <span className={cn(base, "border-white/10 bg-black/60 text-white/70")}>
        <LocateFixed className="size-3.5" /> Finding you…
      </span>
    );
  }
  return (
    <span className={cn(base, "border-white/10 bg-black/60 text-white/70")}>
      <LocateOff className="size-3.5" />
      {NOT_SHARING_LABEL[state]}
    </span>
  );
}
