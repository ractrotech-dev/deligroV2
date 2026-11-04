/**
 * What a shop form takes from a Google Places result. Null when the result has
 * no position: pressing Enter without choosing from Google's list gives a result
 * holding only the typed text, and that must not become a shop's location.
 */
export interface ShopPlace {
  name: string;
  address: string;
  lat: number;
  lng: number;
  pincode: string | null;
}

export function shopPlaceFrom(place: google.maps.places.PlaceResult): ShopPlace | null {
  const location = place.geometry?.location;
  if (!location) return null;
  const lat = location.lat();
  const lng = location.lng();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const postal = place.address_components?.find((c) => c.types.includes("postal_code"));
  return {
    name: place.name ?? "",
    address: place.formatted_address ?? "",
    lat,
    lng,
    pincode: postal?.long_name ?? null,
  };
}
