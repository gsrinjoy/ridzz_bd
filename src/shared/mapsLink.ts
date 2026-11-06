import { isValidLatLng, type LatLng } from './geo';

export interface ParsedPlace extends Partial<LatLng> {
  name?: string;
}

/** Hosts that may be followed when expanding a shared link. The Worker relies on this list. */
export const MAPS_LINK_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com', 'google.com', 'www.google.co.in', 'google.co.in'];

const PAIR = '(-?\\d{1,3}\\.\\d+),\\s*(-?\\d{1,3}\\.\\d+)';

const pair = (la?: string, lo?: string): LatLng | undefined => {
  const a = Number(la);
  const b = Number(lo);
  return isValidLatLng(a, b) ? { la: a, lo: b } : undefined;
};

/** Finds the first http(s) or geo: link inside shared text such as Google Maps' "Name, address, link". */
export function extractLink(text: string): string | undefined {
  return text.match(/(?:https?:\/\/|geo:)[^\s]+/i)?.[0];
}

export function isShortMapsLink(url: string): boolean {
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(url);
}

/** Reads a place out of a Google Maps link, geo: URI, or plain "lat, lng" text. */
export function parseMapsLink(input: string): ParsedPlace | undefined {
  const text = input.trim();
  const whole = text.match(new RegExp(`^${PAIR}$`));
  if (whole) return pair(whole[1], whole[2]);

  const link = extractLink(text);
  if (!link) return undefined;
  const decoded = decodeURIComponent(link.replace(/\+/g, ' '));

  const name = decoded.match(/\/maps\/place\/([^/@]+)/)?.[1]?.trim();
  // The !3d!4d pair is the place itself; @lat,lng is only where the camera was.
  const pin = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const param = decoded.match(new RegExp(`[?&](?:q|query|ll|destination|daddr|center)=(?:loc:)?${PAIR}`));
  const geo = decoded.match(new RegExp(`^geo:${PAIR}`));
  const camera = decoded.match(new RegExp(`@${PAIR}`));
  const found = pin ?? param ?? geo ?? camera;
  const coords = found ? pair(found[1], found[2]) : undefined;

  const query = decoded.match(/[?&](?:q|query|destination|daddr)=([^&]+)/)?.[1]?.trim();
  const label = name ?? (coords ? undefined : query);
  if (!coords && !label) return undefined;
  return { ...coords, ...(label ? { name: label } : {}) };
}

/** Opens Google Maps with turn-by-turn to a point. Keyless and free, per Google's Maps URLs docs. */
export function directionsUrl(to: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.la},${to.lo}&travelmode=two-wheeler&dir_action=navigate`;
}

/** Google allows 3 waypoints on mobile browsers, so longer plans go leg by leg. */
export function routeUrl(stops: LatLng[]): string | undefined {
  const last = stops[stops.length - 1];
  if (!last) return undefined;
  const via = stops.slice(0, -1).slice(0, 3).map((s) => `${s.la},${s.lo}`).join('%7C');
  return directionsUrl(last) + (via ? `&waypoints=${via}` : '');
}
