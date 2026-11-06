import { registerPlugin } from '@capacitor/core';
import { decode, encode, fromBase64, hashRider, KIND_AUDIO, KIND_CONTROL, Relay, toBase64 } from './packets';

/** The Android side. Only in the APK: no website can reach Nearby Connections. See NearbyLinkPlugin.java. */
interface NearbyLinkPlugin {
  start(options: { code: string; name: string }): Promise<void>;
  stop(): Promise<void>;
  send(options: { data: string }): Promise<void>;
  addListener(event: 'data', handler: (e: { data: string }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'peers', handler: (e: { count: number }) => void): Promise<{ remove(): Promise<void> }>;
}

const plugin = registerPlugin<NearbyLinkPlugin>('NearbyLink');

export interface LinkEvents {
  onAudio(sender: number, packet: Uint8Array): void;
  onControl(json: unknown): void;
  onPeers(count: number): void;
}

/** A phone-to-phone link for when the internet is gone. */
export class NearbyLink {
  private readonly self: number;
  private readonly relay: Relay;
  private seq = 0;
  private listeners: { remove(): Promise<void> }[] = [];

  constructor(selfId: string, private readonly events: LinkEvents) {
    this.self = hashRider(selfId);
    this.relay = new Relay(this.self);
  }

  async start(code: string, name: string): Promise<void> {
    this.listeners = [
      await plugin.addListener('data', ({ data }) => this.receive(fromBase64(data))),
      await plugin.addListener('peers', ({ count }) => this.events.onPeers(count)),
    ];
    await plugin.start({ code, name });
  }

  private receive(bytes: Uint8Array): void {
    const packet = decode(bytes);
    if (!packet) return;
    const { deliver, forward } = this.relay.receive(packet);
    if (forward) void plugin.send({ data: toBase64(encode(forward)) });
    if (!deliver) return;
    if (packet.kind === KIND_AUDIO) this.events.onAudio(packet.sender, packet.body);
    if (packet.kind === KIND_CONTROL) this.events.onControl(JSON.parse(new TextDecoder().decode(packet.body)));
  }

  private send(kind: number, body: Uint8Array): void {
    this.seq = (this.seq + 1) & 0xffff;
    const data = encode({ kind, hops: 0, sender: this.self, seq: this.seq, body });
    void plugin.send({ data: toBase64(data) }).catch(() => undefined);
  }

  sendAudio(packet: Uint8Array): void {
    this.send(KIND_AUDIO, packet);
  }

  sendControl(json: unknown): void {
    this.send(KIND_CONTROL, new TextEncoder().encode(JSON.stringify(json)));
  }

  async stop(): Promise<void> {
    await Promise.all(this.listeners.map((l) => l.remove()));
    this.listeners = [];
    await plugin.stop().catch(() => undefined);
  }
}
