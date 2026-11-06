import type { RTCIceServerLike, Rider, VoicePublication } from '../../../../shared/protocol';
import { tuneOpus } from '../sdp';
import { connectionRtt, SenderGate, type TransportEvents, type VoiceTransport } from './types';

export interface SfuApi {
  newSession(): Promise<{ sessionId: string }>;
  tracks(sessionId: string, body: unknown): Promise<TracksResponse>;
  renegotiate(sessionId: string, body: unknown): Promise<unknown>;
}

interface TrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface TracksResponse {
  sessionDescription?: RTCSessionDescriptionInit;
  requiresImmediateRenegotiation?: boolean;
  tracks?: TrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const GATHER_TIMEOUT_MS = 2_000;
const MAX_RETRY_MS = 8_000;

/** Cloudflare Realtime: each rider sends one stream and the edge fans it out. */
export class SfuTransport implements VoiceTransport {
  readonly kind = 'sfu';
  private pc: RTCPeerConnection | undefined;
  private gate: SenderGate | undefined;
  private track: MediaStreamTrack | undefined;
  private sessionId = '';
  private sending = true;
  private closed = false;
  private attempts = 0;
  /** riderId -> publication currently pulled */
  private readonly pulled = new Map<string, VoicePublication>();
  private readonly midToRider = new Map<string, string>();
  private wanted: Rider[] = [];
  /** The API requires one mutation at a time per session. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly selfId: string,
    private readonly iceServers: RTCIceServerLike[],
    private readonly api: SfuApi,
    private readonly publish: (pub: VoicePublication | null) => void,
    private readonly events: TransportEvents,
  ) {}

  async start(track: MediaStreamTrack): Promise<void> {
    this.track = track;
    await this.connect();
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async connect(): Promise<void> {
    const track = this.track as MediaStreamTrack;
    const { sessionId } = await this.api.newSession();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.sessionId = sessionId;
    this.pulled.clear();
    this.midToRider.clear();

    pc.ontrack = (e) => {
      const rider = this.midToRider.get(e.transceiver.mid ?? '');
      if (rider) this.events.onRemoteStream(rider, new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => this.watch(pc);

    const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
    this.gate = new SenderGate(transceiver.sender);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);

    const trackName = `rider-${this.selfId}`;
    const res = await this.api.tracks(sessionId, {
      sessionDescription: { type: 'offer', sdp: pc.localDescription?.sdp },
      tracks: [{ location: 'local', mid: transceiver.mid, trackName }],
    });
    assertTracks(res);
    const answer = res.sessionDescription as RTCSessionDescriptionInit;
    await pc.setRemoteDescription({ ...answer, sdp: tuneOpus(answer.sdp ?? '') });
    await connected(pc);

    this.attempts = 0;
    this.gate.set(this.sending);
    this.publish({ sessionId, trackName });
    this.events.onHealth('live', this.pulled.size);
    this.syncRiders(this.wanted);
  }

  /** The SFU session is rebuilt rather than patched: it is quick, and it always works. */
  private watch(pc: RTCPeerConnection): void {
    if (pc !== this.pc || this.closed) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void this.rebuild();
    else if (pc.connectionState === 'disconnected') this.events.onHealth('recovering', this.pulled.size);
  }

  private async rebuild(): Promise<void> {
    if (this.closed) return;
    this.events.onHealth('recovering', 0);
    this.pc?.close();
    this.pc = undefined;
    try {
      await this.enqueue(() => this.connect());
    } catch {
      const wait = Math.min(MAX_RETRY_MS, 500 * 2 ** this.attempts++);
      setTimeout(() => void this.rebuild(), wait);
    }
  }

  syncRiders(riders: Rider[]): void {
    this.wanted = riders;
    if (!this.pc) return;
    for (const r of riders) {
      if (r.id === this.selfId || !r.voice) continue;
      const have = this.pulled.get(r.id);
      if (have?.sessionId === r.voice.sessionId && have.trackName === r.voice.trackName) continue;
      const pub = r.voice;
      this.pulled.set(r.id, pub);
      void this.enqueue(() => this.pull(r.id, pub)).catch(() => this.pulled.delete(r.id));
    }
    // Only leaving the call ends a pull. A control-socket blip does not touch the audio.
    const present = new Set(riders.filter((r) => r.voice).map((r) => r.id));
    for (const id of [...this.pulled.keys()]) {
      if (!present.has(id)) {
        this.pulled.delete(id);
        this.events.onRemoteGone(id);
      }
    }
  }

  private async pull(riderId: string, pub: VoicePublication): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const res = await this.api.tracks(this.sessionId, {
      tracks: [{ location: 'remote', sessionId: pub.sessionId, trackName: pub.trackName }],
    });
    assertTracks(res);
    const mid = res.tracks?.[0]?.mid;
    if (mid) this.midToRider.set(mid, riderId);
    if (res.requiresImmediateRenegotiation && res.sessionDescription) {
      await pc.setRemoteDescription(res.sessionDescription);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      await this.api.renegotiate(this.sessionId, { sessionDescription: { type: 'answer', sdp: pc.localDescription?.sdp } });
    }
    this.events.onHealth('live', this.pulled.size);
  }

  setSending(on: boolean): void {
    this.sending = on;
    this.gate?.set(on);
  }

  async rttMs(): Promise<number | null> {
    return this.pc ? connectionRtt(this.pc) : null;
  }

  close(): void {
    this.closed = true;
    this.publish(null);
    this.pc?.close();
  }
}

/** A 200 can still carry per-track failures, which the docs say to check individually. */
function assertTracks(res: TracksResponse): void {
  const bad = res.errorCode ?? res.tracks?.find((t) => t.errorCode)?.errorCode;
  if (bad) throw new Error(`SFU: ${bad}`);
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function connected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('connectionstatechange', check);
      reject(new Error('SFU connect timed out'));
    }, CONNECT_TIMEOUT_MS);
    const check = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(timer);
        pc.removeEventListener('connectionstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('connectionstatechange', check);
  });
}
