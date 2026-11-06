import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleSearch } from '../../src/server/modules/places/google';

describe('Google place search', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (body: unknown, status = 200) => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  };

  it('sends the documented request', async () => {
    const f = stub({ places: [] });
    await googleSearch('Nandi Hills', { la: 12.97, lo: 77.59 }, 'KEY');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(headers['x-goog-api-key']).toBe('KEY');
    expect(headers['x-goog-fieldmask']).toBe('places.displayName,places.formattedAddress,places.location');
    expect(JSON.parse(init.body as string)).toMatchObject({
      textQuery: 'Nandi Hills',
      locationBias: { circle: { center: { latitude: 12.97, longitude: 77.59 } } },
    });
  });

  it('reads name, address and position from the response', async () => {
    stub({ places: [{ displayName: { text: 'Nandi Hills' }, formattedAddress: 'Karnataka, India', location: { latitude: 13.37, longitude: 77.68 } }] });
    expect(await googleSearch('x', undefined, 'KEY')).toEqual([{ name: 'Nandi Hills', detail: 'Karnataka, India', la: 13.37, lo: 77.68 }]);
  });

  it('skips places without a position', async () => {
    stub({ places: [{ displayName: { text: 'Nowhere' } }] });
    expect(await googleSearch('x', undefined, 'KEY')).toEqual([]);
  });

  it('treats no results as an empty list', async () => {
    stub({});
    expect(await googleSearch('x', undefined, 'KEY')).toEqual([]);
  });

  it('fails loudly so the caller can fall back', async () => {
    stub({ error: 'quota' }, 429);
    await expect(googleSearch('x', undefined, 'KEY')).rejects.toThrow('429');
  });
});
