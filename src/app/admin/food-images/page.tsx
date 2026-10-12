import { requireRole } from "@/lib/auth";
import { redirect } from "next/navigation";

/** Old URL — Storage is the page now. Keep the query so a search still lands. */
export default async function FoodImagesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { q } = await searchParams;
  const query = (q ?? "").trim();
  redirect(query ? `/admin/storage?q=${encodeURIComponent(query)}` : "/admin/storage");
}
