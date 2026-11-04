"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import type { BannerStatus } from "@/types";
import {
  deleteBannerAction,
  duplicateBannerAction,
  setBannerStatusAction,
} from "./actions";

const menuItemCls =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium hover:bg-surface-2 disabled:opacity-50";

/**
 * A campaign card's controls: Edit, Pause or Set live, and the rarer ones under
 * More. Each button calls a server action and refreshes the list.
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
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setOpen(false);
    start(async () => {
      const res = await fn();
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Link href={`/admin/banners/${id}`} className="c-btn c-btn-outline">
        Edit
      </Link>
      <button
        type="button"
        className="c-btn c-btn-outline"
        disabled={pending}
        onClick={() => run(() => setBannerStatusAction(id, status === "active" ? "paused" : "active"))}
      >
        {status === "active" ? "Pause" : "Set live"}
      </button>

      <div ref={menu} className="relative ml-auto">
        <button
          type="button"
          className="c-btn-quiet grid size-8 place-items-center"
          disabled={pending}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <MoreHorizontal className="size-4" />
        </button>
        {open ? (
          <div
            role="menu"
            className="absolute bottom-full right-0 z-20 mb-1 w-36 rounded-[var(--c-r)] border border-line bg-surface p-1 shadow-lg"
          >
            <button type="button" role="menuitem" className={menuItemCls} onClick={() => run(() => duplicateBannerAction(id))}>
              Duplicate
            </button>
            {status !== "archived" ? (
              <button type="button" role="menuitem" className={menuItemCls} onClick={() => run(() => setBannerStatusAction(id, "archived"))}>
                End campaign
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={`${menuItemCls} text-deal`}
              onClick={() => {
                if (window.confirm("Delete this campaign permanently?")) run(() => deleteBannerAction(id));
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
