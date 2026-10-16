import { cn } from "@/lib/utils/cn";

/**
 * A shop's face in the console: its photo, or its initials on its own tint.
 *
 * `accentTint` is a per-vendor gradient class pair, so the fallback is an
 * identity rather than a placeholder — twenty shops without photos read as
 * twenty different shops, which matters because on a real database most of them
 * have not uploaded one.
 */
export function VendorAvatar({
  name,
  imageUrl,
  accentTint,
  className,
}: Readonly<{
  name: string;
  imageUrl: string | null;
  accentTint: string | null;
  className?: string;
}>) {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-xl ring-1 ring-line",
        className ?? "size-9"
      )}
    >
      {imageUrl ? (
        // Vendor photos are arbitrary storage URLs and this renders at ~36px —
        // there is nothing for the image pipeline to save here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="size-full object-cover" />
      ) : (
        <>
          <span
            className={cn(
              "absolute inset-0 bg-gradient-to-br",
              accentTint ||
                "from-[var(--accent)] to-[color-mix(in_srgb,var(--accent)_45%,var(--ink))]"
            )}
          />
          <span className="relative text-[12px] font-bold tracking-tight text-white">
            {monogram(name)}
          </span>
        </>
      )}
    </span>
  );
}

/** Up to two initials, skipping the words that are on half the signboards. */
function monogram(name: string): string {
  const SKIP = new Set([
    "the",
    "shri",
    "sri",
    "new",
    "hotel",
    "cafe",
    "restaurant",
  ]);
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !SKIP.has(w.toLowerCase()));
  const use = words.length ? words : name.split(/\s+/).filter(Boolean);
  return use.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}
