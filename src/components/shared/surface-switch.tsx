import Link from "next/link";
import {
  Bike,
  ChevronRight,
  ClipboardList,
  Terminal,
  ShieldCheck,
  Store,
  UtensilsCrossed,
} from "lucide-react";
import type { Surface, SurfaceKey } from "@/lib/auth/surfaces";

/**
 * The two ways a list of surfaces (see lib/auth/surfaces.ts) gets shown:
 * big cards on the sign-in chooser, compact rows on the profile tab.
 *
 * Both are plain links. The destination's own layout is what decides whether
 * the account may actually go there — see the note on surfacesForRole.
 */

const LOOK: Record<
  SurfaceKey,
  { icon: typeof Store; chip: string }
> = {
  customer: { icon: UtensilsCrossed, chip: "bg-accent/12 text-accent" },
  admin: { icon: ShieldCheck, chip: "bg-green/12 text-green" },
  manager: { icon: ClipboardList, chip: "bg-violet-500/15 text-violet-500" },
  vendor: { icon: Store, chip: "bg-deal/12 text-deal" },
  driver: { icon: Bike, chip: "bg-blue/12 text-blue" },
  developer: { icon: Terminal, chip: "bg-pop/25 text-pop-ink" },
};

/** Full-width cards — the "where do you want to go" chooser. */
export function SurfaceCards({ surfaces }: Readonly<{ surfaces: readonly Surface[] }>) {
  return (
    <div className="space-y-2.5">
      {surfaces.map((s) => {
        const { icon: Icon, chip } = LOOK[s.key];
        return (
          <Link
            key={s.key}
            href={s.href}
            className="press flex items-center gap-3.5 rounded-2xl border border-line bg-surface p-4 text-left"
          >
            <span
              className={`grid size-11 shrink-0 place-items-center rounded-xl ${chip}`}
            >
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold">
                {s.label}
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                {s.blurb}
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted" />
          </Link>
        );
      })}
    </div>
  );
}

/** List rows, matching the other profile-tab rows. */
export function SurfaceRows({ surfaces }: Readonly<{ surfaces: readonly Surface[] }>) {
  return (
    <div className="divide-y divide-line">
      {surfaces.map((s) => {
        const { icon: Icon, chip } = LOOK[s.key];
        return (
          <Link
            key={s.key}
            href={s.href}
            className="press flex w-full items-center gap-3 py-3 text-left"
          >
            <span
              className={`grid size-9 shrink-0 place-items-center rounded-xl ${chip}`}
            >
              <Icon className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">
                {s.label}
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-muted">
                {s.blurb}
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted" />
          </Link>
        );
      })}
    </div>
  );
}
