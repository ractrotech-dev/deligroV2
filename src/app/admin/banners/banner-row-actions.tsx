"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import Link from "next/link";
import {
  Copy,
  Pause,
  Pencil,
  Play,
  Archive,
  Trash2,
} from "lucide-react";
import type { BannerStatus } from "@/types";
import { cn } from "@/lib/utils/cn";
import {
  deleteBannerAction,
  duplicateBannerAction,
  setBannerStatusAction,
} from "./actions";

/**
 * The per-campaign controls on the Admin list. Each button calls a server
 * action and refreshes the row; pause/resume flips on the current status.
 */
export function BannerRowActions({
  id,
  status,
}: Readonly<{
  id: string;
  status: BannerStatus;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });

  // Base chip + a per-action colour, so the controls read as colourful as the
  // rest of the admin section. Each keeps its own hue with a matching hover tint.
  const base =
    "press grid size-9 place-items-center rounded-full bg-surface-2 transition-colors disabled:opacity-50";
  const tone = {
    blue: "text-blue hover:bg-blue/15",
    accent: "text-accent hover:bg-accent/15",
    green: "text-green hover:bg-green/15",
    violet: "text-violet-500 hover:bg-violet-500/15",
    deal: "text-deal hover:bg-deal/15",
  } as const;

  return (
    <div className="flex items-center gap-1.5">
      <Link
        href={`/admin/banners/${id}`}
        className={cn(base, tone.blue)}
        aria-label="Edit campaign"
        title="Edit"
      >
        <Pencil className="size-4" />
      </Link>

      {status === "active" ? (
        <button
          type="button"
          className={cn(base, tone.accent)}
          disabled={pending}
          title="Pause"
          aria-label="Pause campaign"
          onClick={() => run(() => setBannerStatusAction(id, "paused"))}
        >
          <Pause className="size-4" />
        </button>
      ) : (
        <button
          type="button"
          className={cn(base, tone.green)}
          disabled={pending}
          title="Set live"
          aria-label="Activate campaign"
          onClick={() => run(() => setBannerStatusAction(id, "active"))}
        >
          <Play className="size-4" />
        </button>
      )}

      <button
        type="button"
        className={cn(base, tone.violet)}
        disabled={pending}
        title="Duplicate"
        aria-label="Duplicate campaign"
        onClick={() => run(() => duplicateBannerAction(id))}
      >
        <Copy className="size-4" />
      </button>

      {status !== "archived" ? (
        <button
          type="button"
          className={cn(base, tone.blue)}
          disabled={pending}
          title="Archive"
          aria-label="Archive campaign"
          onClick={() => run(() => setBannerStatusAction(id, "archived"))}
        >
          <Archive className="size-4" />
        </button>
      ) : null}

      <button
        type="button"
        className={cn(base, tone.deal)}
        disabled={pending}
        title="Delete"
        aria-label="Delete campaign"
        onClick={() => {
          if (window.confirm("Delete this campaign permanently?")) {
            run(() => deleteBannerAction(id));
          }
        }}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
