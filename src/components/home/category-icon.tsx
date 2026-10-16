"use client";

import { useState } from "react";

type Props = {
  /** Category id — used only for the alt text's stability, not to pick an asset. */
  id: string;
  /** The photograph. Curated default, or the operator's replacement. */
  image: string;
  /** Gradient behind the photo — visible while it loads, and if it never does. */
  tint: string;
  /** Last resort if the image 404s or the network drops it. */
  emoji: string;
  label: string;
};

/**
 * A category tile: a photograph of the food, over its gradient.
 *
 * This used to render `/icons/categories/<id>.svg` for four of the eight
 * categories and an emoji for the rest — two visual languages in one strip, and
 * the four SVGs were 1.3–1.9 MB EACH (6.5 MB to draw four 64px tiles, on a
 * Tier-3 mobile connection, above the fold). The photographs that replaced them
 * are ~8 KB apiece from a CDN the CSP already allows.
 *
 * The gradient is not decoration: it is what the tile looks like for the whole
 * time the photo is in flight, which on a slow connection is the part most
 * people see. Same rule as `PhotoTile` for restaurant covers — photography
 * supplies the colour, the gradient holds its place.
 */
export function CategoryIcon({ id, image, tint, emoji, label }: Readonly<Props>) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className="relative block size-full overflow-hidden rounded-xl"
      style={{ background: tint }}
      data-category={id}
    >
      {failed ? (
        <span className="grid size-full place-items-center text-3xl">
          {emoji}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt={label}
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
