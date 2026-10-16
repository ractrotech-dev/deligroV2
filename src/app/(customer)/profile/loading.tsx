/**
 * Profile skeleton — shown while the profile summary resolves, so the tab
 * paints at once. This file also covers the screens under /profile (addresses,
 * help, privacy…), so it is a generic shape: a title, one card, a list of rows.
 */
export default function ProfileLoading() {
  return (
    <div className="animate-pulse space-y-5 px-4 pt-5">
      <div className="h-7 w-32 rounded bg-surface-2" />
      <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface-2 p-4">
        <div className="size-16 shrink-0 rounded-full bg-surface" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-1/2 rounded bg-surface" />
          <div className="h-3 w-1/3 rounded bg-surface" />
        </div>
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 rounded-xl bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
