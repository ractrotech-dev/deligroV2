import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { ImageIcon } from "lucide-react";
import { AdminHero, EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { getHomeCategories } from "@/lib/categories";
import {
  categoryImagesReady,
  getCategoryImageOverrides,
} from "@/lib/data-access/category-images";
import {
  foodImagesReady,
  listFoodImages,
  type FoodImage,
} from "@/lib/data-access/food-images";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { FoodImageLibrary } from "../food-images/food-image-library";
import { CategoriesForm } from "../settings/categories/categories-form";

/**
 * Admin → Storage.
 *
 * One place for pictures the platform owns: the shared dish library shops
 * pick from, and the cuisine-strip tiles on customer Home. Those used to be
 * two rail items; they are the same job (host a photo, point the app at it).
 */
export const dynamic = "force-dynamic";

type Tab = "photos" | "categories";

export default async function StoragePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ q?: string; tab?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { q, tab: tabRaw } = await searchParams;
  const query = (q ?? "").trim();
  const tab: Tab = tabRaw === "categories" ? "categories" : "photos";

  return (
    <>
      <AdminHero
        title="Storage"
        subtitle={
          tab === "photos"
            ? "One shared picture per dish — shops get the right one automatically"
            : "The tiles on the customer home screen. Replace any with a photo of the real thing."
        }
      />

      <StorageTabs tab={tab} query={query} />

      {tab === "photos" ? (
        <PhotosPanel query={query} />
      ) : (
        <CategoriesPanel />
      )}
    </>
  );
}

function StorageTabs({ tab, query }: Readonly<{ tab: Tab; query: string }>) {
  const photosHref = query
    ? `/admin/storage?q=${encodeURIComponent(query)}`
    : "/admin/storage";

  return (
    <div
      className="no-scrollbar mb-4 flex gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface p-0.5 text-xs"
      role="tablist"
      aria-label="Storage sections"
    >
      <TabLink href={photosHref} active={tab === "photos"}>
        Food photos
      </TabLink>
      <TabLink
        href="/admin/storage?tab=categories"
        active={tab === "categories"}
      >
        Category pictures
      </TabLink>
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: Readonly<{
  href: string;
  active: boolean;
  children: React.ReactNode;
}>) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={
        "press shrink-0 whitespace-nowrap rounded-md px-[11px] py-[5px] transition-colors " +
        (active
          ? "bg-ink font-semibold text-[color:var(--surface)]"
          : "font-medium text-muted hover:text-ink")
      }
    >
      {children}
    </Link>
  );
}

async function PhotosPanel({ query }: Readonly<{ query: string }>) {
  let images: FoodImage[] = [];
  let ready = false;

  if (isSupabaseConfigured) {
    ready = await foodImagesReady().catch(() => false);
    if (ready) {
      images = await listFoodImages({
        query: query || undefined,
        limit: 120,
      }).catch(() => []);
    }
  }

  return (
    <>
      {isSupabaseConfigured && !ready ? (
        <PreviewNotice>
          Not set up yet — apply migration{" "}
          <code className="rounded bg-surface-2 px-1">
            0035_food_image_library.sql
          </code>{" "}
          to store food photos. Until then shops upload their own pictures as
          before.
        </PreviewNotice>
      ) : null}

      {!isSupabaseConfigured ? (
        <EmptyState
          icon={ImageIcon}
          title="Connect Supabase"
          description="Food photos are stored in Supabase. Connect it to start building the library."
        />
      ) : (
        <FoodImageLibrary images={images} query={query} disabled={!ready} />
      )}

      <div className="rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-muted">
        <p className="font-semibold text-ink">How the matching works</p>
        <p className="mt-1">
          Name each photo the way the dish is written on a menu — “Chicken
          Biryani”, “Egg Biryani”, “Veg Biryani”. When a shop adds an item, the
          name is matched word by word, and a photo is only used when the kind of
          dish agrees: a chicken dish will never be given a vegetarian photo, and
          a plain “Biryani” is left for a person to choose. Common spellings are
          understood too — “Murgh Biryani” finds the chicken photo, “Anda
          Biryani” finds the egg one.
        </p>
      </div>
    </>
  );
}

async function CategoriesPanel() {
  const [categories, ready, overrides] = await Promise.all([
    getHomeCategories(),
    isSupabaseConfigured ? categoryImagesReady() : Promise.resolve(false),
    isSupabaseConfigured
      ? getCategoryImageOverrides().catch(() => new Map<string, string>())
      : Promise.resolve(new Map<string, string>()),
  ]);

  return (
    <>
      {!ready ? (
        <PreviewNotice>
          Showing the default pictures. Apply migration{" "}
          <code className="rounded bg-surface-2 px-1">
            0037_category_images.sql
          </code>{" "}
          to your database to save replacements. Until then the app runs on
          these defaults, which is a working strip — nothing is broken.
        </PreviewNotice>
      ) : null}

      <p className="admin-measure mb-4 text-sm text-muted">
        Pictures must be <strong>https</strong> and hosted on{" "}
        <code className="rounded bg-surface-2 px-1">images.unsplash.com</code> or
        your Supabase storage — the app&apos;s content-security policy blocks
        every other host, so a URL from anywhere else would save and then render
        blank. To use your own photo, upload it to Supabase storage and paste the
        public URL.
      </p>

      <div className="admin-measure">
        <CategoriesForm
          categories={categories}
          overridden={[...overrides.keys()]}
        />
      </div>
    </>
  );
}
