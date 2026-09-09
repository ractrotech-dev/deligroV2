import Link from "next/link";
import { StatusText } from "@/components/admin/console";
import { Plus, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listCategories } from "@/lib/data-access/vendor-categories";
import { AdminHero, EmptyState } from "@/components/admin/admin-ui";
import { CategoryRowActions } from "./category-row-actions";

export const dynamic = "force-dynamic";

export default async function VendorCategoriesPage() {
  // includeDisabled: admins manage the full taxonomy, enabled or not.
  const categories = await listCategories(true);

  return (
    <div className="space-y-4">
      <AdminHero
        backHref="/admin/vendors"
        backLabel="Vendors"
        title="Categories"
        tag={`${categories.length} total`}
        subtitle="The taxonomy that groups shops on the customer feed"
        action={
          <Link href="/admin/vendors/categories/new">
            <Button size="sm">
              <Plus className="size-3.5" /> Add category
            </Button>
          </Link>
        }
      />

      {categories.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No categories yet"
          description="Add categories like Restaurant, Café or Grocery."
          action={
            <Link href="/admin/vendors/categories/new">
              <Button size="sm">
                <Plus className="size-4" /> Add category
              </Button>
            </Link>
          }
        />
      ) : (
        // One divided card, not a stack of them — the console renders a list of
        // like things as a single surface, the way every other queue here does.
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {categories.map((c) => (
            <li
              key={c.id}
              className="c-rowin flex items-center gap-3 border-b border-[color:var(--c-divider)] px-4 py-2.5 transition-colors last:border-b-0 hover:bg-[var(--c-hover)]"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
                <Tags className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-[13px] font-semibold">{c.name}</p>
                  {!c.enabled ? (
                    <StatusText tone="neutral">Disabled</StatusText>
                  ) : null}
                </div>
                <p className="truncate text-[11.5px] text-muted">
                  {c.description || `/${c.slug}`}
                </p>
              </div>
              <CategoryRowActions id={c.id} name={c.name} enabled={c.enabled} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
