import type { LatLng } from '../../../shared/geo';
import type { PlaceHit } from '../../../shared/protocol';

interface GooglePlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
}

const BIAS_RADIUS_M = 50_000;

/**
 * Google's Text Search (New). The field mask below keeps requests on the Pro tier.
 * Used only when GOOGLE_PLACES_KEY is set: Google requires a billing account for
 * it, so without a key the app stays on free search.
 */
export async function googleSearch(q: string, near: LatLng | undefined, key: string): Promise<PlaceHit[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
      'x-goog-fieldmask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      textQuery: q,
      pageSize: 6,
      regionCode: 'IN',
      ...(near ? { locationBias: { circle: { center: { latitude: near.la, longitude: near.lo }, radius: BIAS_RADIUS_M } } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Google search failed: ${res.status}`);
  const { places = [] } = (await res.json()) as { places?: GooglePlace[] };
  return places.flatMap((p) =>
    p.location
      ? [{ name: p.displayName?.text ?? 'Place', detail: p.formattedAddress ?? '', la: p.location.latitude, lo: p.location.longitude }]
      : [],
  );
}
