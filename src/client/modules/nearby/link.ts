import { registerPlugin } from '@capacitor/core';
import { MeshRouter } from './mesh';
import { decode, encode, encodeFrames, fromBase64, hashRider, KIND_AUDIO, KIND_CONTROL, KIND_HELLO, Relay, toBase64 } from './packets';

/** The Android side. Only in the APK: no website can reach Nearby Connections. See NearbyLinkPlugin.java. */
export interface NearbyRadio {
  prepare(): Promise<{ granted: boolean }>;
  start(options: { code: string; name: string }): Promise<void>;
  stop(): Promise<void>;
  connect(options: { endpointId: string }): Promise<void>;
  setDiscovery(options: { on: boolean }): Promise<void>;
  send(options: { data: string; except?: string }): Promise<void>;
  addListener(event: 'data', handler: (e: { from: string; data: string }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'found', handler: (e: { endpointId: string; name: string }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'peers', handler: (e: { endpoints: string[] }) => void): Promise<{ remove(): Promise<void> }>;
}

const plugin = registerPlugin<NearbyRadio>('NearbyLink');

/** Android only. Run while the rider can still tap Allow. */
export const prepareNearby = () => plugin.prepare();

/** How often each phone says hello, which is also how the mesh learns who is reachable. */
const TICK_MS = 4000;
const DIAL_RETRY_MS = 15_000;
const FRAMES_PER_PACKET = 2;

export interface LinkEvents {
  onAudio(sender: number, packet: Uint8Array): void;
  onControl(json: unknown): void;
  /** How many riders can be reached, directly or through others. */
  onPeers(count: number): void;
}

/** A phone-to-phone mesh for when the internet is gone. */
export class NearbyLink {
  private readonly self: number;
  private readonly relay: Relay;
  private readonly router: MeshRouter;
  private readonly found = new Map<string, number>();
  private readonly dialedAt = new Map<string, number>();
  private seq = 0;
  private frames: Uint8Array[] = [];
  private discovering = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners: { remove(): Promise<void> }[] = [];

  constructor(selfId: string, private readonly events: LinkEvents, private readonly radio: NearbyRadio = plugin) {
    this.self = hashRider(selfId);
    this.relay = new Relay(this.self);
    this.router = new MeshRouter(this.self);
  }

  async start(code: string): Promise<void> {
    this.listeners = [
      await this.radio.addListener('data', ({ from, data }) => this.receive(fromBase64(data), from)),
      await this.radio.addListener('found', ({ endpointId, name }) => {
        this.found.set(endpointId, Number(name));
        this.dial();
      }),
      await this.radio.addListener('peers', ({ endpoints }) => {
        this.router.setLinks(endpoints);
        this.tick();
      }),
    ];
    await this.radio.start({ code, name: String(this.self) });
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    this.send(KIND_HELLO, new Uint8Array());
    this.dial();
    const wanted = this.router.shouldDiscover();
    if (wanted !== this.discovering) {
      this.discovering = wanted;
      if (!wanted) this.found.clear(); // A phone can only be dialled during the scan that found it.
      void this.radio.setDiscovery({ on: wanted }).catch(() => undefined);
    }
    this.events.onPeers(this.router.reachable().length);
  }

  private dial(): void {
    const now = Date.now();
    for (const [endpointId, rider] of this.found) {
      if (this.router.isLinked(endpointId) || now - (this.dialedAt.get(endpointId) ?? 0) < DIAL_RETRY_MS) continue;
      if (this.router.shouldDial(rider)) {
        this.dialedAt.set(endpointId, now);
        void this.radio.connect({ endpointId }).catch(() => undefined);
      }
    }
  }

  private receive(bytes: Uint8Array, from: string): void {
    const packet = decode(bytes);
    if (!packet) return;
    const { deliver, forward } = this.relay.receive(packet);
    if (forward) void this.radio.send({ data: toBase64(encode(forward)), except: from }).catch(() => undefined);
    if (!deliver) return;
    this.router.heard(packet.sender);
    if (packet.kind === KIND_AUDIO) this.events.onAudio(packet.sender, packet.body);
    if (packet.kind === KIND_CONTROL) this.events.onControl(JSON.parse(new TextDecoder().decode(packet.body)));
  }

  private send(kind: number, body: Uint8Array): void {
    this.seq = (this.seq + 1) & 0xffff;
    const data = encode({ kind, hops: 0, sender: this.self, seq: this.seq, body });
    void this.radio.send({ data: toBase64(data) }).catch(() => undefined);
  }

  sendAudio(frame: Uint8Array): void {
    this.frames.push(frame);
    if (this.frames.length < FRAMES_PER_PACKET) return;
    this.send(KIND_AUDIO, encodeFrames(this.frames));
    this.frames = [];
  }

  sendControl(json: unknown): void {
    this.send(KIND_CONTROL, new TextEncoder().encode(JSON.stringify(json)));
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all(this.listeners.map((l) => l.remove()));
    this.listeners = [];
    await this.radio.stop().catch(() => undefined);
  }
}
