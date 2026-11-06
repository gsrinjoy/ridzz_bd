import { isValidLatLng } from '../../../shared/geo';
import { MAPS_LINK_HOSTS, parseMapsLink } from '../../../shared/mapsLink';
import type { PlaceHit, RouteResult } from '../../../shared/protocol';
import { fail, json, type Env } from '../../env';
import { currentUser } from '../auth/routes';
import { directory } from '../directory/Directory';
import { googleSearch } from './google';

const UA = { 'user-agent': 'Slipstream/0.1 (private group-ride app)' };
const DAY = 'public, max-age=86400';
const MONTH_S = 2_592_000;
const MAP_HOST = 'https://tiles.openfreemap.org';
/** Exactly the files a map needs, so this can never serve as a general proxy. */
const MAP_FILE = /^(planet\/[\w-]+\/\d{1,2}\/\d{1,7}\/\d{1,7}\.pbf|fonts\/[\w%-]+\/\d+-\d+\.pbf|sprites\/[\w-]+\/[\w@-]+\.(json|png))$/;

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

/**
 * Map files come through this Worker because the page is already connected here.
 * The tile host has several addresses and some networks cannot reach all of them:
 * in India a browser was seen hanging on a dead one for 30 seconds and more.
 */
export async function mapFile(request: Request, file: string): Promise<Response> {
  const site = request.headers.get('sec-fetch-site');
  if ((site && site !== 'same-origin') || !MAP_FILE.test(file)) return fail(404, 'Not found');
  const upstream = await fetch(`${MAP_HOST}/${file}`, { headers: UA, cf: { cacheTtl: MONTH_S, cacheEverything: true } });
  // Reusing the response keeps the host's compression, which matters on mobile data.
  const response = new Response(upstream.body, upstream);
  response.headers.delete('set-cookie');
  response.headers.set('cache-control', upstream.ok ? `public, max-age=${MONTH_S}, immutable` : 'no-store');
  return response;
}

/** The tile index. Near the Worker's free limit, tiles go straight to their host instead. */
async function tileIndex(request: Request, env: Env): Promise<Response> {
  const res = await fetch(`${MAP_HOST}/planet`, { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return fail(502, 'Tile index unavailable');
  const index = await res.json<{ tiles: string[] }>();
  if (!(await directory(env).isLocked('worker_requests'))) {
    const proxy = `${new URL(request.url).origin}/api/map/file`;
    index.tiles = index.tiles.map((url) => url.replace(MAP_HOST, proxy));
  }
  return json(index, 200, { 'cache-control': 'public, max-age=3600' });
}

export async function placesRoutes(request: Request, env: Env, path: string[]): Promise<Response | undefined> {
  const [, resource, action] = path;
  if (resource === 'map' && action === 'index.json') return tileIndex(request, env);
  if (resource !== 'route' && resource !== 'places') return undefined;
  // Riders only: these lean on free public services, whose limits must not be spent by strangers.
  const user = await currentUser(request, env);
  if (user instanceof Response) return user;
  const params = new URL(request.url).searchParams;
  const dir = directory(env);
  if (resource === 'route') {
    if (await dir.isLocked('routing')) return fail(429, 'Routing is paused until tomorrow');
    await dir.addUsage({ routing: 1 });
    return route(params.get('coords') ?? '');
  }
  if (resource !== 'places') return undefined;
  if (action === 'search') {
    const q = (params.get('q') ?? '').trim().slice(0, 120);
    if (q.length < 2) return json([]);
    const lat = params.get('lat');
    const lon = params.get('lon');
    const near = lat && lon ? { lat, lon } : undefined;
    if (env.GOOGLE_PLACES_KEY && !(await dir.isLocked('google_search'))) {
      try {
        const point = near ? { la: Number(near.lat), lo: Number(near.lon) } : undefined;
        const hits = await googleSearch(q, point, env.GOOGLE_PLACES_KEY);
        await dir.addUsage({ google_search: 1 });
        return json(hits);
      } catch {
        // Out of quota or a bad key: free search is better than none.
      }
    }
    if (await dir.isLocked('place_search')) return fail(429, 'Search is paused until tomorrow');
    await dir.addUsage({ place_search: 1 });
    return json(await geocode(q, near), 200, { 'cache-control': DAY });
  }
  if (action === 'resolve') return resolve(params.get('url') ?? '');
  return undefined;
}
