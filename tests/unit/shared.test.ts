import { describe, expect, it } from 'vitest';
import { bearingDeg, distanceM, formatDistance, isValidLatLng } from '../../src/shared/geo';
import { directionsUrl, extractLink, googleSearchUrl, isShortMapsLink, parseMapsLink, routeUrl } from '../../src/shared/mapsLink';

describe('parseMapsLink', () => {
  it('prefers the place pin over the camera position', () => {
    const url = 'https://www.google.com/maps/place/Nandi+Hills/@13.3,77.6,14z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.3702!4d77.6835';
    expect(parseMapsLink(url)).toEqual({ la: 13.3702, lo: 77.6835, name: 'Nandi Hills' });
  });
  it('reads q= coordinates', () => {
    expect(parseMapsLink('https://maps.google.com/?q=12.9716,77.5946')).toEqual({ la: 12.9716, lo: 77.5946 });
  });
  it('reads a directions destination', () => {
    expect(parseMapsLink('https://www.google.com/maps/dir/?api=1&destination=19.076,72.8777')).toEqual({ la: 19.076, lo: 72.8777 });
  });
  it('reads geo: URIs and plain pairs', () => {
    expect(parseMapsLink('geo:28.6139,77.209?q=India+Gate')).toMatchObject({ la: 28.6139, lo: 77.209 });
    expect(parseMapsLink(' 12.9716, 77.5946 ')).toEqual({ la: 12.9716, lo: 77.5946 });
  });
  it('finds the link inside text shared from the Google Maps app', () => {
    const shared = 'Indian Oil Petrol Pump\nNH 44, Hosur\nhttps://maps.google.com/?q=12.7409,77.8253';
    expect(extractLink(shared)).toBe('https://maps.google.com/?q=12.7409,77.8253');
    expect(parseMapsLink(shared)).toEqual({ la: 12.7409, lo: 77.8253 });
  });
  it('keeps a place name when a link has no coordinates', () => {
    expect(parseMapsLink('https://www.google.com/maps/place/Coorg/data=!4m2')).toEqual({ name: 'Coorg' });
  });
  it('rejects impossible coordinates and ordinary text', () => {
    expect(parseMapsLink('95.1234, 200.1234')).toBeUndefined();
    expect(parseMapsLink('meet at the pump')).toBeUndefined();
  });
  it('recognises short share links', () => {
    expect(isShortMapsLink('https://maps.app.goo.gl/abc123')).toBe(true);
    expect(isShortMapsLink('https://example.com/abc123')).toBe(false);
  });
});

describe('directions', () => {
  it('hands off to Google Maps in two-wheeler navigation', () => {
    expect(directionsUrl({ la: 12.5, lo: 77.5 })).toBe('https://www.google.com/maps/dir/?api=1&destination=12.5,77.5&travelmode=two-wheeler&dir_action=navigate');
  });
  it('caps waypoints at the 3 Google allows on mobile browsers', () => {
    const stops = [1, 2, 3, 4, 5, 6].map((n) => ({ la: n, lo: n }));
    const url = routeUrl(stops) as string;
    expect(url).toContain('destination=6,6');
    expect(url.match(/waypoints=([^&]+)/)?.[1]?.split('%7C')).toHaveLength(3);
  });
  it('opens a Google Maps search, biased to where the rider is', () => {
    expect(googleSearchUrl('Indian Oil')).toBe('https://www.google.com/maps/search/?api=1&query=Indian%20Oil');
    expect(googleSearchUrl('Indian Oil', { la: 12.97, lo: 77.59 })).toContain('near%2012.970%2C77.590');
  });
  it('has no route without stops', () => {
    expect(routeUrl([])).toBeUndefined();
  });
});

describe('geo', () => {
  it('measures Bengaluru to Mysuru at about 128 km', () => {
    const km = distanceM({ la: 12.9716, lo: 77.5946 }, { la: 12.2958, lo: 76.6394 }) / 1000;
    expect(km).toBeGreaterThan(125);
    expect(km).toBeLessThan(131);
  });
  it('finds compass bearings', () => {
    expect(bearingDeg({ la: 0, lo: 0 }, { la: 1, lo: 0 })).toBeCloseTo(0);
    expect(bearingDeg({ la: 0, lo: 0 }, { la: 0, lo: 1 })).toBeCloseTo(90);
  });
  it('formats distances for a glance', () => {
    expect(formatDistance(84)).toBe('80 m');
    expect(formatDistance(2340)).toBe('2.3 km');
    expect(formatDistance(45210)).toBe('45 km');
  });
  it('validates coordinates', () => {
    expect(isValidLatLng(12, 77)).toBe(true);
    expect(isValidLatLng(91, 77)).toBe(false);
    expect(isValidLatLng(Number.NaN, 77)).toBe(false);
  });
});
