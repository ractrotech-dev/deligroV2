"use client";

import { useActionState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  setCategoryImageAction,
  type CategoryImageResult,
} from "./actions";
import type { Category } from "@/types";

const EMPTY: CategoryImageResult = { ok: false };

/**
 * One row per category: the picture as customers currently see it, and a field
 * to point it somewhere else.
 *
 * A form per row rather than one big form, because these are independent facts
 * and a single save button would make replacing one picture look like a
 * commitment to whatever is in the other fourteen fields.
 */
export function CategoriesForm({
  categories,
  overridden,
}: Readonly<{
  categories: Category[];
  /** Ids currently pointing at an operator-set picture rather than the default. */
  overridden: string[];
}>) {
  const overriddenSet = new Set(overridden);

  return (
    <div className="space-y-3">
      {categories.map((c) => (
        <CategoryRow
          key={c.id}
          category={c}
          isOverridden={overriddenSet.has(c.id)}
        />
      ))}
    </div>
  );
}

function CategoryRow({
  category,
  isOverridden,
}: Readonly<{
  category: Category;
  isOverridden: boolean;
}>) {
  const [state, action, pending] = useActionState(
    setCategoryImageAction,
    EMPTY
  );

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-3 rounded-[var(--c-r)] border border-line bg-surface p-3"
    >
      <input type="hidden" name="id" value={category.id} />

      {/* What the customer sees right now — the only reliable way to tell a
          working URL from a plausible one. */}
      <span
        className="size-14 shrink-0 overflow-hidden rounded-[var(--c-r)]"
        style={{ background: category.tint }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={category.image}
          alt={category.label}
          width={56}
          height={56}
          className="size-full object-cover"
        />
      </span>

      <span className="min-w-[7rem]">
        <span className="block text-[15px] font-semibold text-ink">
          {category.label}
        </span>
        <span className="block text-xs text-muted">
          {isOverridden ? "Custom picture" : "Default picture"}
        </span>
      </span>

      <input
        // Remounted when the saved picture changes, so a Reset empties the box.
        key={isOverridden ? category.image : "default"}
        name="imageUrl"
        defaultValue={isOverridden ? category.image : ""}
        placeholder="https://…  (blank = use the default)"
        className="c-field min-w-[16rem] flex-1"
        aria-label={`Picture URL for ${category.label}`}
      />

      <Button size="sm" disabled={pending} type="submit">
        {pending ? "Saving…" : "Save"}
      </Button>

      {isOverridden ? (
        // Its own field, not a second imageUrl: FormData keeps both values and
        // the action reads the first, which is the text box. The action turns it
        // into "delete the row", the same path as never having set one.
        <Button
          size="sm"
          variant="ghost"
          type="submit"
          name="reset"
          value="1"
          disabled={pending}
          title="Back to the default picture"
        >
          <RotateCcw className="size-4" /> Reset
        </Button>
      ) : null}

      {state.error ? (
        <p className="w-full text-sm text-deal">{state.error}</p>
      ) : null}
      {state.ok ? (
        <p className="w-full text-sm text-green">Saved.</p>
      ) : null}
    </form>
  );
}
