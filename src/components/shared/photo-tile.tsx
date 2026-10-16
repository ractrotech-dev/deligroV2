import Image from "next/image";
import { cn } from "@/lib/utils/cn";

/**
 * Food photography — "photography is the color". When `src` is set the real
 * image carries the warmth; the gradient `tint` stays underneath as the
 * backdrop while the photo loads (or if it ever fails to).
 *
 * Renders through `next/image` (`fill`, matching this tile's own box) so a
 * real vendor photo — served as whatever size was uploaded, sometimes several
 * MB — gets resized and format-negotiated (AVIF/WebP) for the size it's
 * actually shown at, rather than shipping the original to a 72px tile.
 */
export function PhotoTile({
  tint,
  src,
  alt,
  label,
  className,
  children,
  /** Caller's best guess at this tile's rendered width, for correct responsive sizing. Defaults to a full-bleed guess. */
  sizes = "100vw",
  /** Set for a tile guaranteed to be in the initial viewport (a hero photo, the first banner slide) so it isn't lazy-loaded and doesn't delay LCP. */
  priority = false,
}: Readonly<{
  tint: string;
  src?: string;
  alt?: string;
  label?: string;
  className?: string;
  children?: React.ReactNode;
  sizes?: string;
  priority?: boolean;
}>) {
  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={{ background: tint }}
    >
      {src ? (
        <Image
          src={src}
          alt={alt ?? ""}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
        />
      ) : (
        /* subtle sheen so flat gradients read as a photo surface */
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,.28), transparent 55%)",
          }}
        />
      )}
      {label ? (
        <span className="absolute left-3 top-3 text-3xl drop-shadow-sm">
          {label}
        </span>
      ) : null}
      {children}
    </div>
  );
}
