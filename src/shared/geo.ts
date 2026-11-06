export interface LatLng {
  la: number;
  lo: number;
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLa = rad(b.la - a.la);
  const dLo = rad(b.lo - a.lo);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.la)) * Math.cos(rad(b.la)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lo - a.lo)) * Math.cos(rad(b.la));
  const x =
    Math.cos(rad(a.la)) * Math.sin(rad(b.la)) -
    Math.sin(rad(a.la)) * Math.cos(rad(b.la)) * Math.cos(rad(b.lo - a.lo));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function formatDistance(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

export function isValidLatLng(la: unknown, lo: unknown): boolean {
  return (
    typeof la === 'number' && typeof lo === 'number' &&
    Number.isFinite(la) && Number.isFinite(lo) &&
    Math.abs(la) <= 90 && Math.abs(lo) <= 180
  );
}
