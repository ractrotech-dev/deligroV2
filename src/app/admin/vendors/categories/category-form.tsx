"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Toggle, fieldCls } from "@/components/ui/field";
import { saveCategoryAction, type ActionResult } from "../actions";
import type { VendorCategory } from "@/lib/data-access/vendor-categories";

export function CategoryForm({ category }: Readonly<{ category?: VendorCategory }>) {
  const editing = Boolean(category);
  const action = saveCategoryAction.bind(null, category?.id ?? "");
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    action,
    { ok: false }
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <p className="rounded-xl border border-deal/30 bg-deal/10 px-3.5 py-3 text-sm font-medium text-deal">
          {state.error}
        </p>
      ) : null}

      <Field label="Name" required>
        <input name="name" defaultValue={category?.name} className={fieldCls} required />
      </Field>
      <Field label="Description">
        <input
          name="description"
          defaultValue={category?.description ?? ""}
          className={fieldCls}
          placeholder="Optional"
        />
      </Field>
      <Field label="Sort order" hint="Lower numbers show first.">
        <input
          type="number"
          name="sortOrder"
          defaultValue={category?.sortOrder ?? 0}
          className={fieldCls}
        />
      </Field>
      <Toggle
        name="enabled"
        label="Enabled"
        description="Enabled categories are selectable and power customer filters."
        defaultChecked={category?.enabled ?? true}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Add category"}
        </Button>
        <Link href="/admin/vendors/categories">
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
