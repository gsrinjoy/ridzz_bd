import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stopPinHtml, type RiderPin } from '../../src/client/modules/map/engine';
import { createMapplsEngine, explainRefusal, type MapplsSdk } from '../../src/client/modules/map/mapplsEngine';

// Pins this adapter to the calls in Mappls' V3 docs. Real behaviour needs a real key.
function fakeSdk() {
  const log = { markers: [] as Record<string, unknown>[], lines: [] as Record<string, unknown>[], removed: [] as unknown[], fits: [] as Record<string, unknown>[], mapOptions: {} as Record<string, unknown>, style: '' };
  type Handler = (e?: { lngLat?: { lat: number; lng: number } }) => void;
  const listeners: Record<string, Handler> = {};
  class FakeMap {
    constructor(_id: string, options: Record<string, unknown>) {
      log.mapOptions = options;
    }
    addListener(event: string, handler: Handler) {
      listeners[event] = handler;
    }
    setCenter = vi.fn();
    setZoom = vi.fn();
    getZoom = () => 10;
  }
  class FakeMarker {
    positions: unknown[] = [];
    click?: () => void;
    constructor(public options: Record<string, unknown>) {
      log.markers.push(options);
    }
    setPosition(p: unknown) {
      this.positions.push(p);
    }
    addListener(_e: string, h: () => void) {
      this.click = h;
    }
  }
  class FakeLine {
    constructor(options: Record<string, unknown>) {
      log.lines.push(options);
    }
  }
  class FakeFit {
    constructor(options: Record<string, unknown>) {
      log.fits.push(options);
    }
  }
  const sdk: MapplsSdk = {
    Map: FakeMap,
    Marker: FakeMarker,
    Polyline: FakeLine,
    fitBounds: FakeFit,
    remove: ({ layer }) => log.removed.push(layer),
    getStyles: () => [{ name: 'standard-day' }, { name: 'standard-night' }],
    setStyle: (name) => (log.style = name),
  };
  return { sdk, log, listeners };
}

const pin = (o: Partial<RiderPin> = {}): RiderPin => ({ id: 'a', name: 'Asha', color: '#FF6A1A', pos: { la: 12, lo: 77 }, isMe: false, online: true, talking: false, ...o });

describe('Mappls engine', () => {
  const events = { onRiderTap: vi.fn(), onStopTap: vi.fn(), onLongPress: vi.fn(), onReady: vi.fn(), onUserPan: vi.fn() };
  let f: ReturnType<typeof fakeSdk>;

  const open = async () => {
    const pending = createMapplsEngine(f.sdk, 'map', null, events);
    f.listeners.load?.();
    return pending;
  };

  beforeEach(() => {
    f = fakeSdk();
    events.onRiderTap.mockClear();
    events.onLongPress.mockClear();
  });

  it('starts over India with traffic off', async () => {
    await open();
    expect(f.log.mapOptions).toMatchObject({ center: { lat: 21.5, lng: 78.9 }, zoom: 5, traffic: false });
  });
  it('picks a night style when the account has one', async () => {
    await open();
    expect(f.log.style).toBe('standard-night');
  });
  it('moves an existing marker rather than recreating it', async () => {
    const e = await open();
    e.setRiders([pin()]);
    e.setRiders([pin({ pos: { la: 13, lo: 78 } })]);
    expect(f.log.markers).toHaveLength(1);
    expect(f.log.removed).toHaveLength(0);
  });
  it('replaces a marker when its look changes', async () => {
    const e = await open();
    e.setRiders([pin()]);
    e.setRiders([pin({ talking: true })]);
    expect(f.log.markers).toHaveLength(2);
    expect(f.log.removed).toHaveLength(1);
    expect(f.log.markers[1]?.html).toContain('talking');
  });
  it('removes riders who left', async () => {
    const e = await open();
    e.setRiders([pin()]);
    e.setRiders([]);
    expect(f.log.removed).toHaveLength(1);
  });
  it('escapes rider names, which are other people\'s input', async () => {
    const e = await open();
    e.setRiders([pin({ name: '<img src=x onerror=alert(1)>' })]);
    expect(f.log.markers[0]?.html).not.toContain('<img');
  });
  it('draws routes with lat/lng paths and replaces the old one', async () => {
    const e = await open();
    e.setRoute([{ la: 1, lo: 2 }, { la: 3, lo: 4 }], true);
    expect(f.log.lines[0]).toMatchObject({ path: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], fitbounds: false });
    e.setRoute([{ la: 5, lo: 6 }, { la: 7, lo: 8 }], true);
    expect(f.log.removed).toHaveLength(2); // The line and its casing.
  });
  it('fits bounds in the documented lng,lat order', async () => {
    const e = await open();
    e.fit([{ la: 12, lo: 77 }]);
    expect(f.log.fits[0]).toMatchObject({ cType: 0, bounds: [[77, 12]] });
  });
  it('reports a right-click as a long press', async () => {
    await open();
    f.listeners.contextmenu?.({ lngLat: { lat: 12.5, lng: 77.5 } });
    expect(events.onLongPress).toHaveBeenCalledWith({ la: 12.5, lo: 77.5 });
  });
  it('rejects when the map never loads, so the caller can fall back', async () => {
    vi.useFakeTimers();
    const pending = createMapplsEngine(f.sdk, 'map', null, events);
    const check = expect(pending).rejects.toThrow('did not finish loading');
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
    vi.useRealTimers();
  });
});

describe('why Mappls refused', () => {
  // Real answers from sdk.mappls.com.
  const denied = '{"responsecode":401,"error_description":"Api access denied : app1793965839458i98113197 , ast1566974119i1149949952","error_code":"ASSET_ACCESS_DENIED","error":"Api Access Denied"}';
  const unknown = '{"responsecode":401,"error_description":"Token was not recognised : notARealKey123","error_code":"invalid_token","error":"Invalid Token"}';

  it('says the key is wrong, without repeating it', () => {
    const reason = explainRefusal(401, unknown);
    expect(reason).toContain('Static Key');
    expect(reason).not.toContain('notARealKey123');
  });

  it('says the key is fine but access is missing, with the ids Mappls support needs', () => {
    const reason = explainRefusal(401, denied);
    expect(reason).toContain('accepts this key');
    expect(reason).toContain('ast1566974119i1149949952');
  });

  it('copes with codes it has not met, and with plain text', () => {
    expect(explainRefusal(403, '{"error_code":"DOMAIN_NOT_ALLOWED"}')).toContain('DOMAIN_NOT_ALLOWED');
    expect(explainRefusal(502, '<html>Bad gateway</html>')).toContain('502');
  });

  it('never repeats unknown error text, which can contain the key', () => {
    expect(explainRefusal(401, '{"error_code":"OTHER","error_description":"bad token SECRETKEY"}')).not.toContain('SECRETKEY');
  });

  it('points at the device when Mappls itself answered fine', () => {
    expect(explainRefusal(200, 'var mappls = {}')).toContain('blocked');
  });
});

describe('stop pins', () => {
  const stop = { id: 'a', la: 1, lo: 2, name: 'Tea <stall>', index: 3, kind: 'fuel' as const, selected: false, reached: false };

  it('shows the number and a safe name', () => {
    const html = stopPinHtml(stop);
    expect(html).toContain('>3<');
    expect(html).not.toContain('<stall>');
  });

  it('marks start and finish, the selected stop, and stops already reached', () => {
    expect(stopPinHtml({ ...stop, kind: 'start' })).toContain('kind-start');
    expect(stopPinHtml({ ...stop, kind: 'finish' })).toContain('kind-finish');
    expect(stopPinHtml({ ...stop, selected: true })).toContain('selected');
    const done = stopPinHtml({ ...stop, reached: true });
    expect(done).toContain('reached');
    expect(done).toContain('✓');
  });
});
