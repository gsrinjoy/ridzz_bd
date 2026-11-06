import { isValidLatLng } from '../../../shared/geo';
import { MAPS_LINK_HOSTS, parseMapsLink } from '../../../shared/mapsLink';
import type { PlaceHit, RouteResult } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';

const UA = { 'user-agent': 'Slipstream/0.1 (private group-ride app)' };
const DAY = 'public, max-age=86400';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

async function geocode(q: string, near?: { lat: string; lon: string }): Promise<PlaceHit[]> {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  url.searchParams.set('lang', 'en');
  if (near) {
    url.searchParams.set('lat', near.lat);
    url.searchParams.set('lon', near.lon);
  }
  const res = await fetch(url, { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return [];
  const { features } = await res.json<{ features: PhotonFeature[] }>();
  return features.map(({ geometry, properties: p }) => ({
    name: p.name ?? p.street ?? p.city ?? 'Place',
    detail: [p.city ?? p.county, p.state, p.country].filter(Boolean).join(', '),
    la: geometry.coordinates[1],
    lo: geometry.coordinates[0],
  }));
}

/** Follows a short Google Maps link. Every hop is checked against the allowlist, so this cannot be pointed at other hosts. */
async function expand(link: string): Promise<string | undefined> {
  let current = link;
  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(current);
    if (url.protocol !== 'https:' || !MAPS_LINK_HOSTS.includes(url.hostname)) return undefined;
    const res = await fetch(url, { redirect: 'manual', headers: UA });
    const next = res.headers.get('location');
    if (!next) return current;
    current = new URL(next, url).toString();
  }
  return current;
}

async function resolve(link: string): Promise<Response> {
  const direct = parseMapsLink(link);
  if (direct?.la !== undefined) return json(direct);
  let expanded: string | undefined;
  try {
    expanded = await expand(link);
  } catch {
    return fail(400, 'Could not open that link');
  }
  if (!expanded) return fail(400, 'That is not a Google Maps link');
  const place = parseMapsLink(expanded);
  if (place?.la !== undefined) return json(place);
  // Some share links name the place without coordinates.
  if (place?.name) {
    const hit = (await geocode(place.name))[0];
    if (hit) return json({ name: place.name, la: hit.la, lo: hit.lo });
  }
  return fail(422, 'No location found in that link');
}

async function route(coords: string): Promise<Response> {
  const pairs = coords.split(';').map((p) => p.split(',').map(Number));
  if (pairs.length < 2 || pairs.length > 12 || !pairs.every(([lo, la]) => isValidLatLng(la, lo))) return fail(400, 'Bad coordinates');
  // Public OSRM: fine at this volume, but no uptime promise, so the client treats failure as normal.
  const url = `https://router.project-osrm.org/route/v1/driving/${pairs.map((p) => p.join(',')).join(';')}?overview=simplified&geometries=geojson`;
  const res = await fetch(url, { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return fail(502, 'Routing unavailable');
  const data = await res.json<{ routes?: { distance: number; duration: number; legs: { distance: number; duration: number }[]; geometry: { coordinates: [number, number][] } }[] }>();
  const best = data.routes?.[0];
  if (!best) return fail(404, 'No route');
  return json(
    {
      distanceM: best.distance,
      durationS: best.duration,
      legs: best.legs.map((l) => ({ distanceM: l.distance, durationS: l.duration })),
      line: best.geometry.coordinates,
    } satisfies RouteResult,
    200,
    { 'cache-control': DAY },
  );
}

/** The tile index, cached at the edge so that only the first rider of the day waits for it. */
async function tileIndex(): Promise<Response> {
  const res = await fetch('https://tiles.openfreemap.org/planet', { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return fail(502, 'Tile index unavailable');
  return new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': DAY } });
}

export async function placesRoutes(request: Request, _env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, action] = path;
  if (resource === 'map' && action === 'tiles.json') return tileIndex();
  const params = new URL(request.url).searchParams;
  if (resource === 'route') return route(params.get('coords') ?? '');
  if (resource !== 'places') return undefined;
  if (action === 'search') {
    const q = (params.get('q') ?? '').trim().slice(0, 120);
    if (q.length < 2) return json([]);
    const lat = params.get('lat');
    const lon = params.get('lon');
    return json(await geocode(q, lat && lon ? { lat, lon } : undefined), 200, { 'cache-control': DAY });
  }
  if (action === 'resolve') return resolve(params.get('url') ?? '');
  return undefined;
}
