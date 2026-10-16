/**
 * Is this a number we can actually dial, and what does `tel:` need it to say?
 *
 * Shared by the customer's "call your rider" control and the rider's "call the
 * customer" control, so the two cannot disagree about what counts as a usable
 * number — a `tel:` link built from a half-entered number produces a dialler
 * full of nonsense, which is worse than a control that says it has nothing.
 *
 * Returns null when the number is unusable, which is the callers' signal to
 * render the control disabled rather than hide it.
 */
export function callablePhone(
  phone: string | null | undefined
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  // India-only platform (see lib/location/pinned): a bare 10-digit number is
  // local, anything already carrying 91 is kept as dialled.
  return digits.startsWith("91") ? `+${digits}` : `+91${digits.slice(-10)}`;
}

/**
 * Turn-by-turn to a destination, in whatever the device uses for maps.
 *
 * `google.com/maps/dir/` rather than a `geo:` URI: geo: is Android-only and
 * silently dead on iOS, while this resolves to the Google Maps app when it is
 * installed on either platform and to the web map when it isn't. `dir/?api=1`
 * starts navigation from wherever the device currently is, which is the only
 * origin a rider ever wants.
 *
 * Takes a pin OR an address string. The string form is not a downgrade to be
 * embarrassed about: a great many shops on this platform have never been pinned
 * (`restaurants.lat` is null until a vendor places the marker), and Google's
 * geocoder finding "12, 6th Block, Koramangala" is enormously more use to
 * somebody holding a bag of food than a button that is greyed out because a
 * vendor skipped a step in the onboarding wizard.
 *
 * Returns null when there is neither — the caller renders the control disabled
 * and says why, rather than opening a map of nowhere.
 */
function mapsDirectionsUrl(
  destination: { lat: number; lng: number } | string | null | undefined,
  {
    travelMode,
    navigate = false,
  }: {
    /**
     * Google Maps URLs' `travelmode`. `two-wheeler` is served in India and
     * routes a bike the way a bike goes; where it is not served Google falls
     * back to its own default, so asking for it costs nothing.
     */
    travelMode?: "driving" | "two-wheeler";
    /**
     * `dir_action=navigate` — open straight into turn-by-turn (voice guidance)
     * rather than a route preview the rider then has to press Start on.
     */
    navigate?: boolean;
  } = {}
): string | null {
  const query =
    typeof destination === "string"
      ? destination.trim()
      : destination
        ? `${destination.lat},${destination.lng}`
        : "";
  if (!query) return null;
  const params = new URLSearchParams({ api: "1", destination: query });
  if (travelMode) params.set("travelmode", travelMode);
  if (navigate) params.set("dir_action", "navigate");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * The best map destination for a stop: its pin if it has one, its written
 * address if not.
 *
 * A pin is preferred because it is exact — a street line can geocode to the
 * middle of a long road — but "approximately right" beats "no directions".
 */
export function stopDirectionsUrl(stop: {
  address?: string;
  area?: string;
  point?: { lat: number; lng: number };
}): string | null {
  // Every caller is a rider on two wheels who wants to be guided, not shown a
  // preview — see the Navigate button in driver-board.tsx.
  return mapsDirectionsUrl(stop.point ?? stop.address ?? null, {
    travelMode: "two-wheeler",
    navigate: true,
  });
}
