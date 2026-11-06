import { describe, expect, it } from 'vitest';
import { decode, encode, fromBase64, hashRider, KIND_AUDIO, Relay, toBase64, type Packet } from '../../src/client/modules/nearby/packets';

const packet = (o: Partial<Packet> = {}): Packet => ({ kind: KIND_AUDIO, hops: 0, sender: 7, seq: 1, body: new Uint8Array([1, 2, 3]), ...o });

describe('nearby packets', () => {
  it('survive encoding', () => {
    const p = packet({ sender: 0xdeadbeef, seq: 65535, hops: 2 });
    expect(decode(encode(p))).toEqual(p);
  });
  it('ignore a truncated packet', () => {
    expect(decode(new Uint8Array(4))).toBeUndefined();
  });
  it('add only 8 bytes to each voice packet', () => {
    expect(encode(packet()).length).toBe(11);
  });
  it('survive the trip through the native bridge', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
  it('give each rider a stable id', () => {
    expect(hashRider('abc')).toBe(hashRider('abc'));
    expect(hashRider('abc')).not.toBe(hashRider('abd'));
  });
});

describe('relay', () => {
  it('delivers a new packet and passes it on', () => {
    const r = new Relay(1).receive(packet());
    expect(r.deliver).toBe(true);
    expect(r.forward?.hops).toBe(1);
  });
  it('drops a repeat, so packets cannot loop', () => {
    const relay = new Relay(1);
    relay.receive(packet());
    expect(relay.receive(packet())).toEqual({ deliver: false });
  });
  it('ignores its own packets coming back', () => {
    expect(new Relay(7).receive(packet({ sender: 7 }))).toEqual({ deliver: false });
  });
  it('stops forwarding after nine hops but still plays', () => {
    const r = new Relay(1).receive(packet({ hops: 9 }));
    expect(r.deliver).toBe(true);
    expect(r.forward).toBeUndefined();
  });
  it('keeps memory bounded on a long ride', () => {
    const relay = new Relay(1);
    for (let i = 0; i < 5000; i++) relay.receive(packet({ seq: i % 65536 }));
    expect((relay as unknown as { seen: Set<string> }).seen.size).toBeLessThanOrEqual(512);
  });
  it('remembers senders separately', () => {
    const relay = new Relay(1);
    relay.receive(packet({ sender: 2, seq: 5 }));
    expect(relay.receive(packet({ sender: 3, seq: 5 })).deliver).toBe(true);
  });
});
