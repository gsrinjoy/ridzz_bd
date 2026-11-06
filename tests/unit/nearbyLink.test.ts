import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NearbyLink, type NearbyRadio } from '../../src/client/modules/nearby/link';
import { decodeFrames, hashRider } from '../../src/client/modules/nearby/packets';

type Handler = (event: never) => void;

/** Stands in for Android. Real link.ts on top, pretend air underneath, same rules as NearbyLinkPlugin.java. */
class FakeRadio implements NearbyRadio {
  name = '';
  scanning = false;
  on = false;
  readonly links = new Set<FakeRadio>();
  readonly seen = new Set<string>();
  private handlers: Record<string, Handler[]> = {};

  constructor(readonly id: string, private readonly air: Air) {}

  emit(event: string, payload: unknown) {
    for (const h of this.handlers[event] ?? []) h(payload as never);
  }

  addListener(event: string, handler: Handler) {
    (this.handlers[event] ??= []).push(handler);
    return Promise.resolve({ remove: async () => void (this.handlers[event] = []) });
  }

  prepare = async () => ({ granted: true });

  async start({ name }: { code: string; name: string }) {
    this.name = name;
    this.on = this.scanning = true;
  }

  async setDiscovery({ on }: { on: boolean }) {
    this.scanning = on;
    if (!on) this.seen.clear();
  }

  async connect({ endpointId }: { endpointId: string }) {
    this.air.connect(this, endpointId);
  }

  async send({ data, except }: { data: string; except?: string }) {
    for (const peer of this.links) {
      if (peer.id !== except) peer.emit('data', { from: this.id, data });
    }
  }

  async stop() {
    this.on = this.scanning = false;
    for (const peer of [...this.links]) this.air.cut(this, peer);
  }

  announce() {
    this.emit('peers', { endpoints: [...this.links].map((l) => l.id) });
  }
}

class Air {
  readonly radios: FakeRadio[] = [];

  constructor(public inRange: (a: FakeRadio, b: FakeRadio) => boolean = () => true) {}

  /** What a scanning phone would hear this moment. */
  scan() {
    for (const a of this.radios) {
      if (!a.scanning) continue;
      for (const b of this.radios) {
        if (a === b || !b.on || !this.inRange(a, b) || a.seen.has(b.id)) continue;
        a.seen.add(b.id);
        a.emit('found', { endpointId: b.id, name: b.name });
      }
    }
  }

  connect(from: FakeRadio, id: string) {
    const to = this.radios.find((r) => r.id === id);
    // Android only dials what the current scan has seen, and a full phone rejects.
    if (!to?.on || !from.seen.has(id) || from.links.size >= 4 || to.links.size >= 4) return;
    from.links.add(to);
    to.links.add(from);
    from.announce();
    to.announce();
  }

  cut(a: FakeRadio, b: FakeRadio) {
    a.links.delete(b);
    b.links.delete(a);
    a.announce();
    b.announce();
  }
}

interface Phone {
  radio: FakeRadio;
  link: NearbyLink;
  id: string;
  peers: number;
  heard: Map<number, Uint8Array[]>;
  controls: unknown[];
}

async function phones(air: Air, count: number): Promise<Phone[]> {
  const all: Phone[] = [];
  const first = air.radios.length;
  for (let i = first; i < first + count; i++) {
    const radio = new FakeRadio(`ep${i}`, air);
    air.radios.push(radio);
    const phone: Phone = { radio, id: `rider-${i}`, peers: 0, heard: new Map(), controls: [], link: undefined as never };
    phone.link = new NearbyLink(
      phone.id,
      {
        onAudio: (sender, packet) => phone.heard.set(sender, [...(phone.heard.get(sender) ?? []), ...decodeFrames(packet)]),
        onControl: (json) => phone.controls.push(json),
        onPeers: (n) => (phone.peers = n),
      },
      radio,
    );
    await phone.link.start('RIDE');
    all.push(phone);
  }
  return all;
}

function run(air: Air, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    air.scan();
    vi.advanceTimersByTime(1000);
  }
}

const frame = (n: number) => new Uint8Array([n, n, n]);

describe('the real link code over pretend radios', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('8 phones switched on together all reach each other', async () => {
    const air = new Air();
    const all = await phones(air, 8);
    run(air, 40);
    for (const p of all) expect(p.peers, p.id).toBe(7);
    for (const p of all) expect(p.radio.links.size, p.id).toBeLessThanOrEqual(4);
  });

  it('a rider is heard once by everyone, in order, frames intact', async () => {
    const air = new Air();
    const all = await phones(air, 8);
    run(air, 40);
    const speaker = all[0] as Phone;
    for (let i = 1; i <= 6; i++) speaker.link.sendAudio(frame(i));
    for (const p of all.slice(1)) {
      expect(p.heard.get(hashRider(speaker.id))?.map((f) => f[0]), p.id).toEqual([1, 2, 3, 4, 5, 6]);
    }
    expect(speaker.heard.size).toBe(0);
  });

  it('control messages cross the mesh too', async () => {
    const air = new Air();
    const all = await phones(air, 8);
    run(air, 40);
    (all[3] as Phone).link.sendControl({ id: 'rider-3', msg: { t: 'alert', kind: 'fuel' } });
    for (const p of all) if (p !== all[3]) expect(p.controls).toHaveLength(1);
  });

  it('voice travels along a line of riders who only reach their neighbours', async () => {
    const air = new Air((a, b) => Math.abs(air.radios.indexOf(a) - air.radios.indexOf(b)) === 1);
    const all = await phones(air, 8);
    run(air, 40);
    const front = all[0] as Phone;
    front.link.sendAudio(frame(1));
    front.link.sendAudio(frame(2));
    expect((all[7] as Phone).heard.get(hashRider(front.id))).toHaveLength(2);
  });

  it('stops scanning once settled', async () => {
    const air = new Air();
    const all = await phones(air, 8);
    run(air, 60);
    let scanning = 0;
    for (let i = 0; i < 600; i++) {
      run(air, 1);
      scanning += all.filter((p) => p.radio.scanning).length;
    }
    expect(scanning / (600 * all.length)).toBeLessThan(0.1);
  });

  it('two groups that have both settled join up when they ride together', async () => {
    let apart = true;
    const air = new Air((a, b) => !apart || air.radios.indexOf(a) < 4 === air.radios.indexOf(b) < 4);
    const all = await phones(air, 8);
    run(air, 150);
    for (const p of all) expect(p.peers, p.id).toBe(3);
    apart = false;
    run(air, 150);
    for (const p of all) expect(p.peers, p.id).toBe(7);
  });

  it('heals when a rider in the middle disappears', async () => {
    const air = new Air();
    const all = await phones(air, 8);
    run(air, 40);
    const gone = all[3] as Phone;
    await gone.link.stop();
    run(air, 150);
    for (const p of all) if (p !== gone) expect(p.peers, p.id).toBe(6);
  });

  it('a late rider finds a group that has already settled', async () => {
    const air = new Air();
    const early = await phones(air, 7);
    run(air, 150);
    const all = [...early, ...(await phones(air, 1))];
    run(air, 30);
    for (const p of all) expect(p.peers, p.id).toBe(7);
  });
});
