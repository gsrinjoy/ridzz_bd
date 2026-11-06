import type { LatLng } from '../../../shared/geo';
import { DEFAULT_VIEW, DROPPED_PIN_HTML, escapeHtml, LONG_PRESS_MS, riderLabel, riderPinClass, stopPinHtml, type MapEngine, type MapEvents, type RiderPin } from './engine';

type Point = { lat: number; lng: number };

interface MapplsMap {
  addListener(event: string, handler: (e?: MapplsEvent) => void): void;
  setCenter(at: Point): void;
  setZoom(zoom: number): void;
  getZoom(): number;
  remove?(): void;
}

interface MapplsMarker {
  setPosition(at: Point): void;
  addListener?(event: string, handler: () => void): void;
}

interface MapplsEvent {
  lngLat?: { lat: number; lng: number };
}

/** The slice of the Mappls Web SDK v3 this app uses, from its docs/V3.0 reference. */
export interface MapplsSdk {
  Map: new (containerId: string, options: Record<string, unknown>) => MapplsMap;
  Marker: new (options: Record<string, unknown>) => MapplsMarker;
  Polyline: new (options: Record<string, unknown>) => unknown;
  fitBounds: new (options: Record<string, unknown>) => unknown;
  remove(options: { map: MapplsMap; layer: unknown }): void;
  getStyles?(): unknown;
  setStyle?(name: string): void;
}

const MIN_ZOOM = 5;
const MAX_ZOOM = 18;
const LOAD_TIMEOUT_MS = 10_000;
const SDK_TIMEOUT_MS = 8_000;

const point = (p: LatLng): Point => ({ lat: p.la, lng: p.lo });

function riderHtml(r: RiderPin): string {
  return `<div class="${riderPinClass(r)}" style="background:${escapeHtml(r.color)}" title="${escapeHtml(r.name)}">${escapeHtml(riderLabel(r))}</div>`;
}

/** Mappls centres a marker on its point, so the pin is lifted until its tip is there instead. */
const lifted = (html: string) => `<div class="pin-lift">${html}</div>`;

/**
 * Turns Mappls' answer into something the owner can act on. Only known fields are
 * shown, because some of its error text repeats the key back.
 */
export function explainRefusal(status: number, body: string): string {
  if (status >= 200 && status < 300) return 'Mappls answered normally, but its script was blocked on this device.';
  let answer: { error?: unknown; error_code?: unknown; error_description?: unknown } = {};
  try {
    answer = JSON.parse(body) as typeof answer;
  } catch {
    // Not every failure comes from Mappls itself, so plain text is possible here.
  }
  if (answer.error_code === 'invalid_token') return 'Mappls does not recognise this key. MAPPLS_KEY must be the Static Key from the Mappls console.';
  if (answer.error_code === 'ASSET_ACCESS_DENIED') {
    return `Mappls accepts this key but has not given this app access to the web map. It said: ${String(answer.error_description)}`;
  }
  if (typeof answer.error_code === 'string') return `Mappls refused the map: ${answer.error_code}.`;
  return `Mappls answered with error ${status}.`;
}

/** A script tag only says that it failed, so ask again to read Mappls' reason. */
async function askWhyRefused(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    return explainRefusal(response.status, await response.text());
  } catch {
    return 'Could not reach Mappls from this device.';
  }
}

/** Injects the SDK script once. Rejects with Mappls' own reason, shown in Settings. */
export function loadMapplsSdk(key: string): Promise<MapplsSdk> {
  const w = window as unknown as { mappls?: MapplsSdk };
  if (w.mappls?.Map) return Promise.resolve(w.mappls);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Mappls took too long to load on this connection.')), SDK_TIMEOUT_MS);
    script.src = `https://sdk.mappls.com/map/sdk/web?v=3.0&access_token=${encodeURIComponent(key)}`;
    const url = script.src;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      void askWhyRefused(url).then((reason) => reject(new Error(reason)));
    };
    script.onload = () => {
      clearTimeout(timer);
      if (w.mappls?.Map) resolve(w.mappls);
      else reject(new Error('Mappls loaded without a map.'));
    };
    document.head.append(script);
  });
}

export function createMapplsEngine(sdk: MapplsSdk, containerId: string, start: LatLng | null, events: MapEvents): Promise<MapEngine> {
  const view = start ? { center: start, zoom: 13 } : DEFAULT_VIEW;
  const map = new sdk.Map(containerId, {
    center: point(view.center),
    zoom: view.zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    // Traffic is on by default and costs data and redraws that a rider never looks at.
    traffic: false,
    zoomControl: false,
    scaleControl: false,
    fullscreenControl: false,
    rotateControl: false,
  });

  const riders = new Map<string, { marker: MapplsMarker; html: string }>();
  const stops = new Map<string, { marker: MapplsMarker; html: string }>();
  let dropped: unknown;
  let route: unknown;
  let casing: unknown;
  let link: unknown;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  const drop = (layer: unknown) => {
    if (layer) sdk.remove({ map, layer });
  };

  const polyline = (line: LatLng[], options: Record<string, unknown>) =>
    line.length > 1 ? new sdk.Polyline({ map, path: line.map(point), fitbounds: false, ...options }) : undefined;

  const pickDarkStyle = () => {
    try {
      const styles = sdk.getStyles?.() as { name?: string }[] | undefined;
      const dark = Array.isArray(styles) ? styles.find((s) => /night|dark/i.test(s.name ?? '')) : undefined;
      if (dark?.name) sdk.setStyle?.(dark.name);
    } catch {
      // Styles are per-account, so the default one is a fine answer.
    }
  };

  const pressStart = (e?: MapplsEvent) => {
    const at = e?.lngLat;
    clearTimeout(pressTimer);
    if (at) pressTimer = setTimeout(() => events.onLongPress({ la: at.lat, lo: at.lng }), LONG_PRESS_MS);
  };
  const pressEnd = () => clearTimeout(pressTimer);

  map.addListener('touchstart', pressStart);
  map.addListener('touchend', pressEnd);
  map.addListener('touchmove', pressEnd);
  map.addListener('touchcancel', pressEnd);
  map.addListener('dragstart', () => events.onUserPan());
  map.addListener('contextmenu', (e) => {
    if (e?.lngLat) events.onLongPress({ la: e.lngLat.lat, lo: e.lngLat.lng });
  });

  const engine: MapEngine = {
    provider: 'mappls',

    setRiders(list) {
      const seen = new Set<string>();
      for (const r of list) {
        seen.add(r.id);
        const html = riderHtml(r);
        const existing = riders.get(r.id);
        if (existing?.html === html) {
          existing.marker.setPosition(point(r.pos));
          continue;
        }
        // The SDK cannot restyle a marker, so a talking or offline change replaces it.
        if (existing) drop(existing.marker);
        const marker = new sdk.Marker({ map, position: point(r.pos), html, fitbounds: false });
        marker.addListener?.('click', () => events.onRiderTap(r.id));
        riders.set(r.id, { marker, html });
      }
      for (const [id, entry] of riders) {
        if (!seen.has(id)) {
          drop(entry.marker);
          riders.delete(id);
        }
      }
    },

    setStops(list) {
      const seen = new Set<string>();
      for (const s of list) {
        seen.add(s.id);
        const html = lifted(stopPinHtml(s));
        const existing = stops.get(s.id);
        if (existing?.html === html) {
          existing.marker.setPosition(point(s));
          continue;
        }
        // The SDK cannot restyle a marker, so a changed pin is replaced.
        if (existing) drop(existing.marker);
        const marker = new sdk.Marker({ map, position: point(s), html, fitbounds: false });
        marker.addListener?.('click', () => events.onStopTap(s.id));
        stops.set(s.id, { marker, html });
      }
      for (const [id, entry] of stops) {
        if (!seen.has(id)) {
          drop(entry.marker);
          stops.delete(id);
        }
      }
    },

    setRoute(line, exact) {
      drop(casing);
      drop(route);
      casing = exact ? polyline(line, { strokeColor: '#8F3200', strokeOpacity: 1, strokeWeight: 8 }) : undefined;
      route = polyline(line, { strokeColor: '#FF6A1A', strokeOpacity: 1, strokeWeight: 5, ...(exact ? {} : { lineGap: 2 }) });
    },

    setDropped(at) {
      drop(dropped);
      dropped = at ? new sdk.Marker({ map, position: point(at), html: lifted(DROPPED_PIN_HTML), fitbounds: false }) : undefined;
    },

    setLink(line) {
      drop(link);
      link = polyline(line, { strokeColor: '#1B1E24', strokeOpacity: 0.8, strokeWeight: 2, lineGap: 2 });
    },

    fit(points) {
      if (points.length) {
        new sdk.fitBounds({ map, cType: 0, bounds: points.map((p) => [p.lo, p.la]), options: { padding: 70, duration: 500 } });
      }
    },

    center(at, zoom) {
      map.setCenter(point(at));
      if (zoom) map.setZoom(Math.min(MAX_ZOOM, Math.max(zoom, map.getZoom())));
    },

    destroy() {
      clearTimeout(pressTimer);
      map.remove?.();
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mappls started but its map did not finish loading.')), LOAD_TIMEOUT_MS);
    map.addListener('load', () => {
      clearTimeout(timer);
      pickDarkStyle();
      events.onReady();
      resolve(engine);
    });
  });
}
