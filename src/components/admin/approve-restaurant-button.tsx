"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { approveRestaurantAction } from "@/app/admin/actions";
import { cn } from "@/lib/utils/cn";

/**
 * Approves for real: flips restaurants.approved, which puts the shop on the feed.
 *
 * Two sizes, one implementation. `compact` is the console's inline row action —
 * an outlined chip that inverts on hover — used wherever the approval queue is
 * a list inside a card rather than the subject of the screen.
 */
export function ApproveRestaurantButton({
  id,
  name,
  variant = "default",
}: Readonly<{
  id: string;
  name: string;
  variant?: "default" | "compact";
}>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const approve = () =>
    startTransition(async () => {
      const result = await approveRestaurantAction(id);
      if (!result.ok) setError(result.error ?? "Failed");
    });

  if (variant === "compact") {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span className="text-[11px] font-semibold text-deal">{error}</span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          aria-label={`Approve ${name}`}
          onClick={approve}
          className={cn("c-btn-affirm press inline-flex items-center gap-1", pending && "opacity-60")}
        >
          {pending ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" strokeWidth={2.6} />
          )}
          Approve
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error ? <span className="text-xs text-deal">{error}</span> : null}
      <Button size="sm" disabled={pending} aria-label={`Approve ${name}`} onClick={approve}>
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Check className="size-4" />
        )}
        Approve
      </Button>
    </div>
  );
}
