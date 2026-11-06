import type { LatLng } from '../../../shared/geo';
import { DEFAULT_VIEW, LONG_PRESS_MS, riderLabel, riderPinClass, type MapEngine, type MapEvents, type RiderPin, type StopPin } from './engine';

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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function riderHtml(r: RiderPin): string {
  return `<div class="${riderPinClass(r)}" style="background:${escapeHtml(r.color)}" title="${escapeHtml(r.name)}">${escapeHtml(riderLabel(r))}</div>`;
}

const stopHtml = (s: StopPin) => `<div class="stop-pin num" title="${escapeHtml(s.name)}">${s.index}</div>`;

/** Injects the SDK script once. Rejects on a bad key, because Mappls answers those with an error status. */
export function loadMapplsSdk(key: string): Promise<MapplsSdk> {
  const w = window as unknown as { mappls?: MapplsSdk };
  if (w.mappls?.Map) return Promise.resolve(w.mappls);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Mappls SDK timed out')), SDK_TIMEOUT_MS);
    script.src = `https://sdk.mappls.com/map/sdk/web?v=3.0&access_token=${encodeURIComponent(key)}`;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Mappls SDK refused to load'));
    };
    script.onload = () => {
      clearTimeout(timer);
      if (w.mappls?.Map) resolve(w.mappls);
      else reject(new Error('Mappls SDK loaded without a map'));
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
  const stops: unknown[] = [];
  let route: unknown;
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
      stops.splice(0).forEach(drop);
      for (const s of list) {
        const marker = new sdk.Marker({ map, position: point(s), html: stopHtml(s), fitbounds: false });
        marker.addListener?.('click', () => events.onStopTap(s.id));
        stops.push(marker);
      }
    },

    setRoute(line) {
      drop(route);
      route = polyline(line, { strokeColor: '#FF6A1A', strokeOpacity: 0.9, strokeWeight: 5 });
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
    const timer = setTimeout(() => reject(new Error('Mappls map did not load')), LOAD_TIMEOUT_MS);
    map.addListener('load', () => {
      clearTimeout(timer);
      pickDarkStyle();
      events.onReady();
      resolve(engine);
    });
  });
}
