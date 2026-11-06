import { describe, expect, it } from 'vitest';
import { BRIDGE_WAIT_MS, HARD_LINKS, MeshRouter, REACHABLE_MS, RESCAN_EVERY_MS, SETTLE_MS, SOFT_LINKS } from '../../src/client/modules/nearby/mesh';
import { decodeFrames, encodeFrames, Relay, type Packet } from '../../src/client/modules/nearby/packets';

/** Virtual riders on a road, each running the real routing code over a pretend radio. */
class World {
  time = 0;
  readonly routers = new Map<number, MeshRouter>();
  readonly relays = new Map<number, Relay>();
  readonly links = new Map<number, Set<number>>();
  seq = 0;

  constructor(readonly ids: number[], readonly inRange: (a: number, b: number) => boolean) {
    for (const id of ids) {
      this.routers.set(id, new MeshRouter(id, () => this.time));
      this.relays.set(id, new Relay(id));
      this.links.set(id, new Set());
    }
  }

  private syncLinks(id: number) {
    (this.routers.get(id) as MeshRouter).setLinks([...(this.links.get(id) as Set<number>)].map(String));
  }

  /** One round: riders scan and dial, then each sends a hello. */
  tick() {
    this.time += 4000;
    for (const a of this.ids) {
      const router = this.routers.get(a) as MeshRouter;
      if (!router.shouldDiscover()) continue;
      for (const b of this.ids) {
        if (a === b || !this.inRange(a, b) || this.links.get(a)?.has(b)) continue;
        const other = this.routers.get(b) as MeshRouter;
        if (router.shouldDial(b) && router.canAccept() && other.canAccept()) {
          this.links.get(a)?.add(b);
          this.links.get(b)?.add(a);
          this.syncLinks(a);
          this.syncLinks(b);
        }
      }
    }
    for (const id of this.ids) this.flood(id);
  }

  /** Floods one packet and reports how far it got and what it cost. */
  flood(from: number) {
    const packet: Packet = { kind: 3, hops: 0, sender: from, seq: ++this.seq & 0xffff, body: new Uint8Array() };
    const deliveries = new Map<number, number>();
    let transmissions = 0;
    let deepest = 0;
    const queue: [number, Packet, number][] = [];
    for (const n of this.links.get(from) ?? []) {
      transmissions++;
      queue.push([n, packet, from]);
    }
    while (queue.length) {
      const [at, p, cameFrom] = queue.shift() as [number, Packet, number];
      const { deliver, forward } = (this.relays.get(at) as Relay).receive(p);
      if (deliver) {
        deliveries.set(at, (deliveries.get(at) ?? 0) + 1);
        deepest = Math.max(deepest, p.hops + 1);
        this.routers.get(at)?.heard(from);
      }
      if (forward) {
        for (const n of this.links.get(at) ?? []) {
          if (n === cameFrom) continue;
          transmissions++;
          queue.push([n, forward, at]);
        }
      }
    }
    return { deliveries, transmissions, deepest };
  }

  settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) this.tick();
  }

  unreachedFrom(id: number) {
    const { deliveries } = this.flood(id);
    return this.ids.filter((x) => x !== id && !deliveries.has(x));
  }

  maxLinks() {
    return Math.max(...this.ids.map((id) => this.links.get(id)?.size ?? 0));
  }
}

const riders = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i * 37);

describe('mesh of 8 riders', () => {
  it('works whatever order the riders happen to appear in', () => {
    for (let round = 0; round < 40; round++) {
      const ids = riders(8).sort(() => Math.random() - 0.5);
      const w = new World(ids, () => true);
      w.settle(14);
      for (const id of ids) expect(w.unreachedFrom(id), `round ${round}, from ${id}`).toEqual([]);
      expect(w.maxLinks()).toBeLessThanOrEqual(HARD_LINKS);
    }
  });

  it('holds for random spreads of riders along a road', () => {
    for (let round = 0; round < 40; round++) {
      const ids = riders(8);
      // About 100 m of radio range, with gaps of up to 90 m, so the road always connects.
      let at = 0;
      const spot = new Map(ids.map((id) => [id, (at += 10 + Math.random() * 80)]));
      const w = new World(ids, (a, b) => Math.abs((spot.get(a) as number) - (spot.get(b) as number)) <= 100);
      w.settle(20);
      for (const id of ids) expect(w.unreachedFrom(id), `round ${round}, from ${id}`).toEqual([]);
    }
  });

  it('all together: everyone reaches everyone, within the link limit', () => {
    const w = new World(riders(8), () => true);
    w.settle();
    for (const id of w.ids) expect(w.unreachedFrom(id), `from ${id}`).toEqual([]);
    expect(w.maxLinks()).toBeLessThanOrEqual(HARD_LINKS);
  });

  it('delivers each packet exactly once, so nobody hears an echo', () => {
    const w = new World(riders(8), () => true);
    w.settle();
    const { deliveries } = w.flood(w.ids[0] as number);
    expect([...deliveries.values()].every((n) => n === 1)).toBe(true);
    expect(deliveries.size).toBe(7);
  });

  it('stays light on the radio', () => {
    const w = new World(riders(8), () => true);
    w.settle();
    // A full mesh of 8 would be 56 sends per packet at most.
    expect(w.flood(w.ids[0] as number).transmissions).toBeLessThanOrEqual(8 * HARD_LINKS);
  });

  it('a long line: voice hops from the front of the pack to the back', () => {
    const ids = riders(8);
    const w = new World(ids, (a, b) => Math.abs(ids.indexOf(a) - ids.indexOf(b)) === 1);
    w.settle(16);
    const front = w.flood(ids[0] as number);
    expect(front.deliveries.size).toBe(7);
    expect(front.deepest).toBe(7);
  });

  it('a group of 10 in a line still reaches the last rider', () => {
    const ids = riders(10);
    const w = new World(ids, (a, b) => Math.abs(ids.indexOf(a) - ids.indexOf(b)) === 1);
    w.settle(18);
    expect(w.flood(ids[0] as number).deliveries.size).toBe(9);
  });

  it('two groups that meet join into one mesh', () => {
    const ids = riders(8);
    const group = (x: number) => (ids.indexOf(x) < 4 ? 0 : 1);
    let together = false;
    const w = new World(ids, (a, b) => together || group(a) === group(b));
    w.settle();
    expect(w.unreachedFrom(ids[0] as number)).toHaveLength(4);
    w.settle(RESCAN_EVERY_MS / 4000); // Long enough that nobody is still in the first scan.
    together = true;
    w.settle(RESCAN_EVERY_MS / 4000 + 4); // No links are touched: only the short rescans can do this.
    expect(w.unreachedFrom(ids[0] as number)).toEqual([]);
    expect(w.maxLinks()).toBeLessThanOrEqual(HARD_LINKS);
  });

  it('a settled mesh spends little time scanning', () => {
    const ids = riders(8);
    const w = new World(ids, () => true);
    w.settle(20);
    let scans = 0;
    const rounds = 150; // Ten minutes.
    for (let i = 0; i < rounds; i++) {
      w.tick();
      scans += ids.filter((id) => w.routers.get(id)?.shouldDiscover()).length;
    }
    expect(scans / (rounds * ids.length)).toBeLessThan(0.1);
  });

  it('survives a rider dropping out of the middle', () => {
    const ids = riders(8);
    const gone = ids[3] as number;
    const w = new World(ids, () => true);
    w.settle();
    for (const n of w.links.get(gone) ?? []) {
      w.links.get(n)?.delete(gone);
      (w.routers.get(n) as MeshRouter).setLinks([...(w.links.get(n) as Set<number>)].map(String));
    }
    w.links.get(gone)?.clear();
    const remaining = ids.filter((x) => x !== gone);
    const healed = new World(remaining, () => true);
    healed.settle();
    for (const id of remaining) expect(healed.unreachedFrom(id)).toEqual([]);
  });
});

describe('routing decisions', () => {
  it('never dials past the hard limit, even to heal a split', () => {
    const r = new MeshRouter(1, () => 0);
    r.setLinks(['a', 'b', 'c', 'd']);
    expect(r.shouldDial(99)).toBe(false);
  });
  it('keeps the spare link until the mesh has settled, then bridges a real split', () => {
    let t = 0;
    const r = new MeshRouter(5, () => t);
    r.setLinks(['a', 'b', 'c']);
    expect(r.shouldDial(1)).toBe(false);
    t = BRIDGE_WAIT_MS;
    expect(r.shouldDial(1)).toBe(true);
  });
  it('does not add links once at the soft limit and everyone is reachable', () => {
    const r = new MeshRouter(1, () => 0);
    r.setLinks(['a', 'b', 'c']);
    r.heard(9);
    expect(r.shouldDial(9)).toBe(false);
  });
  it('leaves the first move to the lower id', () => {
    const low = new MeshRouter(1, () => 0);
    const high = new MeshRouter(2, () => 0);
    low.heard(2);
    high.heard(1);
    expect(low.shouldDial(2)).toBe(true);
    expect(high.shouldDial(1)).toBe(false);
  });
  it('forgets riders gone quiet', () => {
    let t = 0;
    const r = new MeshRouter(1, () => t);
    r.heard(2);
    expect(r.reachable()).toEqual([2]);
    t = REACHABLE_MS + 1;
    expect(r.reachable()).toEqual([]);
  });
  it('stops scanning once settled, and starts again if the mesh changes', () => {
    let t = 0;
    const r = new MeshRouter(1, () => t);
    r.setLinks(['a', 'b', 'c']);
    expect(r.shouldDiscover()).toBe(true);
    t = SETTLE_MS + 1;
    expect(r.shouldDiscover()).toBe(false);
    r.setLinks(['a', 'b']);
    expect(r.shouldDiscover()).toBe(true);
  });
  it('always scans while it has no links at all', () => {
    let t = 0;
    const r = new MeshRouter(1, () => t);
    t = SETTLE_MS * 10;
    expect(r.shouldDiscover()).toBe(true);
  });
  it('uses the agreed link limits', () => {
    expect(SOFT_LINKS).toBeLessThan(HARD_LINKS);
  });
});

describe('voice packets', () => {
  it('carry two Opus frames and split back into them', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    expect(decodeFrames(encodeFrames([a, b]))).toEqual([a, b]);
  });
  it('survive a damaged length', () => {
    expect(decodeFrames(new Uint8Array([0, 200, 1]))).toEqual([]);
  });
});
