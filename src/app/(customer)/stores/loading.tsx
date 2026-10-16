/**
 * Stores skeleton — shown while the catalog, settings and address reads in
 * page.tsx resolve, so tapping the tab paints something at once instead of
 * holding the previous screen. Sized like StoresPage: header, category strip,
 * two promo cards, then restaurant cards.
 */
export default function StoresLoading() {
  return (
    <div className="animate-pulse space-y-5 px-4 pt-3">
      <div className="h-14 rounded-2xl bg-surface-2" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="size-16 shrink-0 rounded-2xl bg-surface-2" />
        ))}
      </div>
      <div className="h-28 rounded-2xl bg-surface-2" />
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-40 w-full rounded-2xl bg-surface-2" />
            <div className="h-4 w-2/3 rounded bg-surface-2" />
            <div className="h-3 w-1/3 rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
