import wasmUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url';
import type { Rider, VoiceConfig, VoicePublication } from '../../../shared/protocol';
import { playCue, type Cue } from './cues';
import type { NoiseFilter, TalkMode } from './dsp/chain';
import { MeshTransport } from './transports/mesh';
import { SfuTransport, type SfuApi } from './transports/sfu';
import type { VoiceTransport } from './transports/types';
import type { WorkletCommand, WorkletEvent } from './worklet';
import workletUrl from './worklet.ts?worker&url';

export interface VoiceHost {
  config: VoiceConfig;
  selfId: string;
  sfuApi: SfuApi;
  sendSignal(to: string, data: unknown): void;
  publish(pub: VoicePublication | null): void;
  onTransmit(on: boolean): void;
  onMeter(m: { level: number; wind: number; speech: number }): void;
  onHealth(state: 'live' | 'recovering', peers: number): void;
  /**
   * iPhones: play riders through a plain audio element. It is the path Safari
   * supports best for call audio, at the price of no per-rider volume (iOS
   * ignores element volume) and no speed-based boost. Muting still works.
   */
  directPlayback: boolean;
}

interface RemoteAudio {
  element: HTMLAudioElement;
  source?: MediaStreamAudioSourceNode;
  gain?: GainNode;
}

const micConstraints = (deviceId?: string): MediaTrackConstraints => ({
  // Helmet speakers sit next to the boom mic, so echo cancelling stays on.
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
});

/** Riders hear less at speed, so playback rises with it, up to +6 dB at 120 km/h. */
const speedGain = (kmh: number) => 1 + Math.min(kmh, 120) / 120;

export class VoiceEngine {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private mic: MediaStream | undefined;
  private micSource: MediaStreamAudioSourceNode | undefined;
  private master: GainNode | undefined;
  private volumes: Record<string, number> = {};
  private transport: VoiceTransport | undefined;
  private readonly remotes = new Map<string, RemoteAudio>();

  constructor(private readonly host: VoiceHost) {}

  /**
   * `ctx` must be created inside the tap, before anything is awaited: Safari
   * only lets audio start synchronously within the gesture.
   */
  async start(ctx: AudioContext, mode: TalkMode, sensitivity: number, noiseFilter: NoiseFilter): Promise<void> {
    this.ctx = ctx;
    const [wasm] = await Promise.all([fetch(wasmUrl).then((r) => r.arrayBuffer()), ctx.audioWorklet.addModule(workletUrl)]);

    this.mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });

    const node = new AudioWorkletNode(ctx, 'slipstream-voice', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { wasm },
    });
    this.node = node;
    node.port.onmessage = (e: MessageEvent<WorkletEvent>) => this.onWorklet(e.data);

    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    this.micSource = ctx.createMediaStreamSource(this.mic);
    this.micSource.connect(node).connect(out);

    const master = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 4;
    master.connect(compressor).connect(ctx.destination);
    this.master = master;

    this.command({ type: 'mode', mode });
    this.command({ type: 'sensitivity', value: sensitivity });
    this.command({ type: 'noiseFilter', filter: noiseFilter });

    const track = out.stream.getAudioTracks()[0] as MediaStreamTrack;
    const h = this.host;
    const events = {
      onRemoteStream: (id: string, stream: MediaStream) => this.attachRemote(id, stream),
      onRemoteGone: (id: string) => this.detachRemote(id),
      onHealth: h.onHealth,
    };
    this.transport =
      h.config.mode === 'sfu'
        ? new SfuTransport(h.selfId, h.config.iceServers, h.sfuApi, h.publish, events)
        : new MeshTransport(h.selfId, h.config.iceServers, h.sendSignal, h.publish, events);
    // Silence until the gate opens: a closed gate must cost no radio time.
    this.transport.setSending(mode === 'open');
    await this.transport.start(track);
    await ctx.resume();
  }

  private onWorklet(e: WorkletEvent): void {
    if (e.type === 'tx') {
      this.transport?.setSending(e.on);
      this.host.onTransmit(e.on);
    } else {
      this.host.onMeter(e);
    }
  }

  private command(c: WorkletCommand): void {
    this.node?.port.postMessage(c);
  }

  private attachRemote(id: string, stream: MediaStream): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    this.detachRemote(id);
    const element = new Audio();
    element.setAttribute('playsinline', '');
    element.srcObject = stream;
    if (this.host.directPlayback) {
      element.muted = (this.volumes[id] ?? 1) === 0;
      document.body.append(element);
      void element.play().catch(() => undefined);
      this.remotes.set(id, { element });
      return;
    }
    // Chrome only pumps a remote stream into Web Audio if a media element also holds it.
    element.muted = true;
    void element.play().catch(() => undefined);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.volumes[id] ?? 1;
    source.connect(gain).connect(master);
    this.remotes.set(id, { element, source, gain });
  }

  private detachRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.source?.disconnect();
    r.gain?.disconnect();
    r.element.srcObject = null;
    r.element.remove();
    this.remotes.delete(id);
  }

  /**
   * Swaps the microphone mid-call. WebRTC carries the processed output, not the
   * mic itself, so this needs no renegotiation and nobody hears a drop.
   */
  async selectInput(deviceId: string): Promise<void> {
    const { ctx, node } = this;
    if (!ctx || !node) return;
    const next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
    this.micSource?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = next;
    this.micSource = ctx.createMediaStreamSource(next);
    this.micSource.connect(node);
  }

  async selectOutput(deviceId: string): Promise<void> {
    await (this.ctx as AudioContext & { setSinkId?(id: string): Promise<void> }).setSinkId?.(deviceId);
  }

  setVolumes(volumes: Record<string, number>): void {
    this.volumes = volumes;
    for (const [id, r] of this.remotes) {
      const volume = volumes[id] ?? 1;
      if (r.gain) r.gain.gain.value = volume;
      else r.element.muted = volume === 0;
    }
  }

  setMode(mode: TalkMode): void {
    this.command({ type: 'mode', mode });
  }

  setPtt(held: boolean): void {
    this.command({ type: 'ptt', held });
  }

  setNoiseFilter(filter: NoiseFilter): void {
    this.command({ type: 'noiseFilter', filter });
  }

  setSensitivity(value: number): void {
    this.command({ type: 'sensitivity', value });
  }

  setMeters(on: boolean): void {
    this.command({ type: 'meters', on });
  }

  setSpeed(kmh: number): void {
    this.command({ type: 'speed', kmh });
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(speedGain(kmh), this.ctx.currentTime, 0.5);
  }

  syncRiders(riders: Rider[]): void {
    this.transport?.syncRiders(riders);
  }

  signal(from: string, data: unknown): void {
    this.transport?.signal?.(from, data);
  }

  cue(cue: Cue): void {
    if (this.ctx && this.master) playCue(this.ctx, cue, this.master);
  }

  rttMs(): Promise<number | null> {
    return this.transport?.rttMs() ?? Promise.resolve(null);
  }

  /**
   * Back in the app after a phone call, or a trip to Google Maps on an iPhone,
   * where Safari suspends audio and can end the mic. Restores both unprompted.
   */
  async recover(): Promise<void> {
    const { ctx, node } = this;
    if (!ctx || !node) return;
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    if (this.mic?.getAudioTracks().every((t) => t.readyState === 'ended')) {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      this.micSource?.disconnect();
      this.micSource = ctx.createMediaStreamSource(this.mic);
      this.micSource.connect(node);
    }
    for (const r of this.remotes.values()) void r.element.play().catch(() => undefined);
  }

  stop(): void {
    this.transport?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    for (const id of [...this.remotes.keys()]) this.detachRemote(id);
    // Left open a moment so a goodbye cue can finish.
    const { ctx } = this;
    setTimeout(() => void ctx?.close(), 700);
  }
}
