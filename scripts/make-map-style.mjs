// Builds public/map-style.json from OpenFreeMap's dark style. Shipping the style
// with the app removes a round trip, and the colours are retuned so roads and
// labels can be read at a glance, in daylight, from a handlebar mount.
// Run: node scripts/make-map-style.mjs
import { writeFileSync } from 'node:fs';

const style = await (await fetch('https://tiles.openfreemap.org/styles/dark')).json();

const LAND = '#171B21';
const fillFor = (id) => {
  if (id === 'water') return '#1E3B50';
  if (/park|wood|grass|glacier|ice/.test(id)) return '#1B2A24';
  if (/building/.test(id)) return '#262B33';
  return '#1C2027';
};

const roadColor = (id) => {
  if (/motorway|trunk/.test(id)) return '#8A95A6';
  if (/major|primary|secondary|tertiary/.test(id)) return '#6B7585';
  if (/minor|service|street|path|track/.test(id)) return '#4A5260';
  return '#5A6474';
};

style.layers = style.layers
  // Shaded relief is a raster download that adds nothing at riding zoom levels.
  .filter((l) => l.source !== 'ne2_shaded')
  .map((layer) => {
    const paint = { ...layer.paint };
    const id = layer.id;
    if (layer.type === 'background') paint['background-color'] = LAND;
    if (layer.type === 'fill') {
      paint['fill-color'] = fillFor(id);
      delete paint['fill-outline-color'];
      delete paint['fill-pattern']; // Textures cost memory and blur at a glance.
    }
    if (layer.type === 'line' && id === 'waterway') paint['line-color'] = '#27506B';
    if (layer.type === 'line' && /^aeroway/.test(id)) paint['line-color'] = '#3C434E';
    if (layer.type === 'line' && /highway|road|bridge|tunnel/.test(id)) {
      paint['line-color'] = /casing/.test(id) ? '#0F1216' : roadColor(id);
      paint['line-opacity'] = 1;
    }
    if (layer.type === 'line' && /boundary|admin/.test(id)) paint['line-color'] = '#59616E';
    if (layer.type === 'line' && /railway/.test(id)) paint['line-color'] = /dash/.test(id) ? LAND : '#3C434E';
    if (layer.type === 'symbol' && 'text-field' in (layer.layout ?? {})) {
      const place = /place|country|state/.test(id);
      paint['text-color'] = place ? '#E6EAF0' : /water/.test(id) ? '#7FB2D0' : '#AEB6C2';
      paint['text-halo-color'] = '#0B0D10';
      paint['text-halo-width'] = 1.4;
    }
    return { ...layer, paint };
  });

delete style.sources.ne2_shaded;
// Resolved through the Worker, whose cache answers in milliseconds after the first rider.
style.sources.openmaptiles.url = '/api/map/tiles.json';
writeFileSync('public/map-style.json', JSON.stringify(style));
console.log(`${style.layers.length} layers, ${JSON.stringify(style).length} bytes`);
