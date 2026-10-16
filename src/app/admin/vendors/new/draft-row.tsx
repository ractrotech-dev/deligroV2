"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileClock, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteDraftAction } from "../actions";

/**
 * One row in the "Resume a draft" list: tap the body to resume, or delete the
 * saved draft. Delete runs through the admin-gated server action, then refreshes
 * so the list drops the row.
 */
export function DraftRow({
  id,
  shopName,
  meta,
}: Readonly<{
  id: string;
  shopName: string;
  meta: string;
}>) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function remove() {
    setError(null);
    start(async () => {
      const res = await deleteDraftAction(id);
      if (!res.ok) {
        setError(res.error ?? "Couldn't delete the draft.");
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <li className="flex items-center gap-2">
      <Link
        href={`/admin/vendors/new?draft=${id}`}
        className="press flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5"
      >
        <FileClock className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{shopName}</span>
          <span className="block truncate text-[11px] text-muted">{meta}</span>
        </span>
      </Link>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="press grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted hover:text-deal"
        aria-label={`Delete draft ${shopName}`}
      >
        <Trash2 className="size-4" />
      </button>

      <ConfirmDialog
        open={confirming}
        title="Delete draft?"
        message={
          <>
            This permanently removes the saved registration for{" "}
            <b className="text-ink">{shopName}</b>.{" "}
            {error ? <span className="text-deal">{error}</span> : "This can't be undone."}
          </>
        }
        confirmLabel="Delete"
        danger
        busy={pending}
        onConfirm={remove}
        onClose={() => {
          if (!pending) {
            setConfirming(false);
            setError(null);
          }
        }}
      />
    </li>
  );
}
