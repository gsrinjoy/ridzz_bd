import maplibregl, { type GeoJSONSource, type LineLayerSpecification, type MapMouseEvent, type MapTouchEvent, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLng } from '../../../shared/geo';
import { DEFAULT_VIEW, LONG_PRESS_MS, riderLabel, riderPinClass, type MapEngine, type MapEvents } from './engine';

// Built by scripts/make-map-style.mjs. MapLibre needs an absolute URL for the tile source inside it.
const STYLE = '/map-style.json';

const lngLat = (p: LatLng): [number, number] => [p.lo, p.la];

function feature(line: LatLng[]) {
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: line.map(lngLat) } };
}

/** Free, keyless map for when Mappls has no key or will not load, so riders never lose the map. */
export function createBackupEngine(container: HTMLElement, start: LatLng | null, events: MapEvents): MapEngine {
  const view = start ? { center: start, zoom: 13 } : { ...DEFAULT_VIEW, zoom: 4 };
  const map = new maplibregl.Map({
    container,
    style: STYLE,
    center: lngLat(view.center),
    zoom: view.zoom,
    // Phones gain little above 2x and pay for it in GPU power.
    pixelRatio: Math.min(window.devicePixelRatio, 2),
    fadeDuration: 0,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    attributionControl: { compact: true },
    transformRequest: (url) => (url.startsWith('/') ? { url: location.origin + url } : { url }),
  });
  map.touchZoomRotate.disableRotation();
  map.on('error', (e) => console.warn('map', e.error?.message ?? e));

  const riders = new Map<string, { marker: Marker; el: HTMLDivElement }>();
  const stops: Marker[] = [];
  const lines: Record<'route' | 'link', LatLng[]> = { route: [], link: [] };
  let loaded = false;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  const push = (id: 'route' | 'link') => {
    if (loaded) (map.getSource(id) as GeoJSONSource).setData(feature(lines[id]));
  };

  const addLine = (id: 'route' | 'link', paint: LineLayerSpecification['paint']) => {
    map.addSource(id, { type: 'geojson', data: feature([]) });
    map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, ...(paint ? { paint } : {}) });
  };

  map.on('load', () => {
    addLine('route', { 'line-color': '#FF6A1A', 'line-width': 4, 'line-opacity': 0.9 });
    addLine('link', { 'line-color': '#F2F4F7', 'line-width': 2, 'line-dasharray': [1, 2] });
    loaded = true;
    push('route');
    push('link');
  });

  // The first tile is the moment it looks like a map. Waiting for all of them would
  // leave a loading label up for the whole of a slow connection.
  const firstTile = (e: { dataType?: string; tile?: unknown }) => {
    if (e.dataType !== 'source' || !e.tile) return;
    map.off('data', firstTile);
    events.onReady();
  };
  map.on('data', firstTile);

  const pressStart = (e: MapTouchEvent | MapMouseEvent) => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => events.onLongPress({ la: e.lngLat.lat, lo: e.lngLat.lng }), LONG_PRESS_MS);
  };
  const pressEnd = () => clearTimeout(pressTimer);
  map.on('touchstart', pressStart);
  map.on('touchend', pressEnd);
  map.on('touchcancel', pressEnd);
  map.on('touchmove', pressEnd);
  map.on('movestart', pressEnd);
  map.on('dragstart', () => events.onUserPan());
  map.on('contextmenu', (e) => events.onLongPress({ la: e.lngLat.lat, lo: e.lngLat.lng }));

  return {
    provider: 'backup',

    setRiders(list) {
      const seen = new Set<string>();
      for (const r of list) {
        seen.add(r.id);
        let pin = riders.get(r.id);
        if (!pin) {
          const el = document.createElement('div');
          el.onclick = () => events.onRiderTap(r.id);
          pin = { el, marker: new maplibregl.Marker({ element: el }).setLngLat(lngLat(r.pos)).addTo(map) };
          riders.set(r.id, pin);
        }
        pin.marker.setLngLat(lngLat(r.pos));
        // Swap only our classes: Marker's own class is what positions the pin on the map.
        pin.el.className = `maplibregl-marker maplibregl-marker-anchor-center ${riderPinClass(r)}`;
        pin.el.style.background = r.color;
        pin.el.textContent = riderLabel(r);
        pin.el.title = r.name;
      }
      for (const [id, pin] of riders) {
        if (!seen.has(id)) {
          pin.marker.remove();
          riders.delete(id);
        }
      }
    },

    setStops(list) {
      stops.splice(0).forEach((m) => m.remove());
      for (const s of list) {
        const el = document.createElement('div');
        el.className = 'stop-pin num';
        el.textContent = String(s.index);
        el.title = s.name;
        el.onclick = () => events.onStopTap(s.id);
        stops.push(new maplibregl.Marker({ element: el }).setLngLat(lngLat(s)).addTo(map));
      }
    },

    setRoute(line) {
      lines.route = line;
      push('route');
    },

    setLink(line) {
      lines.link = line;
      push('link');
    },

    fit(points) {
      const first = points[0];
      if (!first) return;
      const bounds = new maplibregl.LngLatBounds(lngLat(first), lngLat(first));
      points.forEach((p) => bounds.extend(lngLat(p)));
      map.fitBounds(bounds, { padding: 70, maxZoom: 14, duration: 500 });
    },

    center(at, zoom) {
      map.easeTo({ center: lngLat(at), ...(zoom ? { zoom: Math.max(map.getZoom(), zoom) } : {}), duration: 500 });
    },

    destroy() {
      clearTimeout(pressTimer);
      // Removing the map frees its GPU memory, which is the point of ride mode.
      map.remove();
    },
  };
}
