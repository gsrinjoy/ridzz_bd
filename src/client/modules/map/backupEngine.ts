import maplibregl, { type GeoJSONSource, type LineLayerSpecification, type MapMouseEvent, type MapTouchEvent, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLng } from '../../../shared/geo';
import { DEFAULT_VIEW, DROPPED_PIN_HTML, LONG_PRESS_MS, riderLabel, riderPinClass, stopPinHtml, type MapEngine, type MapEvents } from './engine';

// Built by scripts/make-map-style.mjs. Its links are relative to this site, which MapLibre will not accept as they are.
const STYLE = '/map-style.json';
const absolute = (url: string) => (url.startsWith('/') ? location.origin + url : url);

const lngLat = (p: LatLng): [number, number] => [p.lo, p.la];

/** Two labels closer than this would run into each other. */
const LABEL_GAP = { x: 120, y: 26 };

const ROUTE_WIDTH = ['interpolate', ['exponential', 1.5], ['zoom'], 8, 3, 12, 5, 16, 9, 19, 16] as const;
const CASING_WIDTH = ['interpolate', ['exponential', 1.5], ['zoom'], 8, 5.5, 12, 8, 16, 13, 19, 21] as const;

/** A chevron along the route shows which way the ride goes, the way a road atlas does. */
function arrowImage(): ImageData {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const pen = canvas.getContext('2d') as CanvasRenderingContext2D;
  pen.strokeStyle = '#fff';
  pen.lineWidth = 5;
  pen.lineCap = pen.lineJoin = 'round';
  pen.beginPath();
  pen.moveTo(11, 7);
  pen.lineTo(21, 16);
  pen.lineTo(11, 25);
  pen.stroke();
  return pen.getImageData(0, 0, size, size);
}

function feature(line: LatLng[]) {
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: line.map(lngLat) } };
}

/** Free, keyless map for when Mappls has no key or will not load, so riders never lose the map. */
export function createBackupEngine(container: HTMLElement, start: LatLng | null, events: MapEvents): MapEngine {
  const view = start ? { center: start, zoom: 13 } : { ...DEFAULT_VIEW, zoom: 4 };
  const map = new maplibregl.Map({
    container,
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
    transformRequest: (url) => ({ url: absolute(url) }),
  });
  map.setStyle(STYLE, {
    transformStyle: (_, next) => ({ ...next, sprite: absolute(next.sprite as string), glyphs: absolute(next.glyphs as string) }),
  });
  map.touchZoomRotate.disableRotation();
  map.on('error', (e) => console.warn('map', e.error?.message ?? e));

  const riders = new Map<string, { marker: Marker; el: HTMLDivElement }>();
  const stops = new Map<string, { marker: Marker; el: HTMLDivElement; html: string }>();
  let stopOrder: string[] = [];
  let dropped: Marker | undefined;
  const lines: Record<'route' | 'link', LatLng[]> = { route: [], link: [] };
  let routeExact = true;
  let loaded = false;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  const push = (id: 'route' | 'link') => {
    if (loaded) (map.getSource(id) as GeoJSONSource).setData(feature(lines[id]));
  };

  const addLine = (id: 'route' | 'link', paint: LineLayerSpecification['paint']) => {
    map.addSource(id, { type: 'geojson', data: feature([]) });
    map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, ...(paint ? { paint } : {}) });
  };

  const showRouteKind = () => {
    if (!loaded) return;
    map.setPaintProperty('route', 'line-dasharray', routeExact ? undefined : [1.5, 1.5]);
    map.setLayoutProperty('route-casing', 'visibility', routeExact ? 'visible' : 'none');
    map.setLayoutProperty('route-arrows', 'visibility', routeExact ? 'visible' : 'none');
  };

  /** Labels are shown in stop order, and a later one gives way rather than overlapping. */
  const declutter = () => {
    const taken: { x: number; y: number }[] = [];
    for (const id of stopOrder) {
      const pin = stops.get(id);
      const label = pin?.el.querySelector<HTMLElement>('.stop-pin-name');
      if (!pin || !label) continue;
      const at = map.project(pin.marker.getLngLat());
      const clash = taken.some((p) => Math.abs(p.x - at.x) < LABEL_GAP.x && Math.abs(p.y - at.y) < LABEL_GAP.y);
      label.hidden = clash && !pin.el.querySelector('.selected');
      if (!label.hidden) taken.push(at);
    }
  };
  map.on('moveend', declutter);

  map.on('load', () => {
    // Above every road, or they cut the route into pieces, and below the labels that follow them.
    const layers = map.getStyle().layers;
    const labels = layers[layers.findLastIndex((l) => l.type !== 'symbol') + 1]?.id;
    const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
    map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 });
    map.addSource('route', { type: 'geojson', data: feature([]) });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#8F3200', 'line-width': CASING_WIDTH as never } }, labels);
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#FF6A1A', 'line-width': ROUTE_WIDTH as never } }, labels);
    map.addLayer(
      {
        id: 'route-arrows',
        type: 'symbol',
        source: 'route',
        minzoom: 13.5,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 130,
          'icon-image': 'route-arrow',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 13.5, 0.6, 15, 0.8, 18, 1.1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
        },
      },
      labels,
    );
    addLine('link', { 'line-color': '#F2F4F7', 'line-width': 2, 'line-dasharray': [1, 2] });
    loaded = true;
    push('route');
    push('link');
    showRouteKind();
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
      for (const s of list) {
        let pin = stops.get(s.id);
        if (!pin) {
          const el = document.createElement('div');
          el.onclick = () => events.onStopTap(s.id);
          pin = { el, html: '', marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat(s)).addTo(map) };
          stops.set(s.id, pin);
        }
        pin.marker.setLngLat(lngLat(s));
        // Only what changed, so editing a plan never makes the pins flash.
        const html = stopPinHtml(s);
        if (html !== pin.html) pin.el.innerHTML = pin.html = html;
        pin.el.style.zIndex = s.selected ? '3' : '2';
      }
      stopOrder = list.map((s) => s.id);
      for (const [id, pin] of stops) {
        if (!stopOrder.includes(id)) {
          pin.marker.remove();
          stops.delete(id);
        }
      }
      declutter();
    },

    setRoute(line, exact) {
      lines.route = line;
      routeExact = exact;
      push('route');
      showRouteKind();
    },

    setDropped(at) {
      dropped?.remove();
      dropped = undefined;
      if (!at) return;
      const el = document.createElement('div');
      el.innerHTML = DROPPED_PIN_HTML;
      dropped = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat(at)).addTo(map);
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
      // Pins rise above the place they mark, and a short map must not run out of room.
      const { clientWidth: width, clientHeight: height } = map.getContainer();
      const side = Math.min(72, width * 0.18);
      map.fitBounds(bounds, {
        padding: { top: Math.min(84, height * 0.3), bottom: Math.min(36, height * 0.12), left: side, right: side },
        maxZoom: 15,
        duration: 600,
      });
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
