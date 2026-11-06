/**
 * Riders in range relay for each other, so a line of bikes stays connected
 * beyond one radio hop. Every packet carries who sent it and a sequence number,
 * which is how a rider recognises one they have already passed along.
 */
export const KIND_AUDIO = 1;
export const KIND_CONTROL = 2;
export const KIND_HELLO = 3;

const HEADER = 8;
/** Enough for the biggest group in a single line of bikes. */
const MAX_HOPS = 9;

export interface Packet {
  kind: number;
  hops: number;
  /** Compact sender id, from hashRider. */
  sender: number;
  seq: number;
  body: Uint8Array;
}

/** Riders are identified by a 32-bit hash: enough for a group of ten, and small on a slow radio. */
export function hashRider(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function encode(p: Packet): Uint8Array {
  const out = new Uint8Array(HEADER + p.body.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, p.kind);
  view.setUint8(1, p.hops);
  view.setUint32(2, p.sender);
  view.setUint16(6, p.seq);
  out.set(p.body, HEADER);
  return out;
}

export function decode(data: Uint8Array): Packet | undefined {
  if (data.length < HEADER) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { kind: view.getUint8(0), hops: view.getUint8(1), sender: view.getUint32(2), seq: view.getUint16(6), body: data.subarray(HEADER) };
}

const SEEN_LIMIT = 512;

/** Drops repeats and decides what to pass on. Bounded, so it cannot grow during a long ride. */
export class Relay {
  private readonly seen = new Set<string>();

  constructor(private readonly self: number) {}

  /** Returns whether to deliver this packet, and a copy to forward if one should go on. */
  receive(p: Packet): { deliver: boolean; forward?: Packet } {
    if (p.sender === this.self) return { deliver: false };
    const key = `${p.sender}:${p.seq}`;
    if (this.seen.has(key)) return { deliver: false };
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    return p.hops < MAX_HOPS ? { deliver: true, forward: { ...p, hops: p.hops + 1 } } : { deliver: true };
  }
}

/** Frames are sent in pairs: half the packets means half the radio overhead, for 20 ms of delay. */
export function encodeFrames(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + 2 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) {
    view.setUint16(at, f.length);
    out.set(f, at + 2);
    at += 2 + f.length;
  }
  return out;
}

export function decodeFrames(body: Uint8Array): Uint8Array[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: Uint8Array[] = [];
  let at = 0;
  while (at + 2 <= body.length) {
    const length = view.getUint16(at);
    if (at + 2 + length > body.length) break;
    frames.push(body.slice(at + 2, at + 2 + length));
    at += 2 + length;
  }
  return frames;
}

export const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

export const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
