import type { RTCIceServerLike, Rider, VoicePublication } from '../../../../shared/protocol';
import { tuneOpus } from '../sdp';
import { connectionRtt, SenderGate, type TransportEvents, type VoiceTransport } from './types';

interface Peer {
  pc: RTCPeerConnection;
  /** Which of the rider's call sessions this link belongs to. A new one means they rejoined. */
  session?: string;
  gate?: SenderGate;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  recovery?: ReturnType<typeof setTimeout>;
}

type Signal = { description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit };

const RECOVERY_DELAY_MS = 2500;

/**
 * Direct rider-to-rider links, used when no relay is configured. When riders
 * share a network this is also the shortest path, because ICE prefers it.
 */
export class MeshTransport implements VoiceTransport {
  readonly kind = 'mesh';
  private track: MediaStreamTrack | undefined;
  private sending = true;
  private readonly peers = new Map<string, Peer>();

  constructor(
    private readonly selfId: string,
    private readonly iceServers: RTCIceServerLike[],
    private readonly sendSignal: (to: string, data: unknown) => void,
    private readonly publish: (pub: VoicePublication | null) => void,
    private readonly events: TransportEvents,
  ) {}

  /**
   * Announcing is what makes joining at different moments safe. An offer sent
   * to someone not yet in the call would vanish, and both sides would then wait
   * on each other forever. So links only ever start towards announced riders.
   */
  async start(track: MediaStreamTrack): Promise<void> {
    this.track = track;
    this.publish({ sessionId: crypto.randomUUID(), trackName: 'mesh' });
    this.events.onHealth('live', 0);
  }

  syncRiders(riders: Rider[]): void {
    const inCall = new Map(riders.filter((r) => r.voice && r.id !== this.selfId).map((r) => [r.id, r]));
    for (const [id, rider] of inCall) {
      const session = rider.voice?.sessionId;
      const peer = this.peers.get(id);
      if (peer?.session !== undefined && peer.session !== session) this.drop(id);
      const current = this.peers.get(id);
      if (current) current.session = session as string;
      else if (rider.online) this.connect(id).session = session as string;
    }
    for (const [id, peer] of this.peers) {
      const rider = inCall.get(id);
      // Audio does not ride on the control socket, so a working link outlives a socket blip.
      if (!rider || (!rider.online && peer.pc.connectionState !== 'connected')) this.drop(id);
    }
  }

  setSending(on: boolean): void {
    this.sending = on;
    for (const p of this.peers.values()) p.gate?.set(on);
  }

  private connect(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle' });
    const peer: Peer = { pc, polite: this.selfId > id, makingOffer: false, ignoreOffer: false };
    this.peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.sendSignal(id, { description: pc.localDescription.toJSON() } satisfies Signal);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal(id, { candidate: e.candidate.toJSON() } satisfies Signal);
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.events.onRemoteStream(id, stream);
    };
    pc.onconnectionstatechange = () => this.watch(id, peer);

    if (this.track) {
      const sender = pc.addTrack(this.track, new MediaStream([this.track]));
      peer.gate = new SenderGate(sender);
      peer.gate.set(this.sending);
    }
    return peer;
  }

  /** Heals a link on its own: wait out a blip, then restart ICE. */
  private watch(id: string, peer: Peer): void {
    const state = peer.pc.connectionState;
    clearTimeout(peer.recovery);
    if (state === 'connected') {
      peer.gate?.set(this.sending);
    } else if (state === 'disconnected' || state === 'failed') {
      peer.recovery = setTimeout(() => peer.pc.restartIce(), state === 'failed' ? 0 : RECOVERY_DELAY_MS);
    }
    const peers = [...this.peers.values()];
    const live = peers.filter((p) => p.pc.connectionState === 'connected').length;
    this.events.onHealth(live === peers.length ? 'live' : 'recovering', live);
    if (state === 'closed') this.events.onRemoteGone(id);
  }

  async signal(from: string, data: unknown): Promise<void> {
    const peer = this.peers.get(from) ?? this.connect(from);
    const { pc } = peer;
    const msg = data as Signal;
    try {
      if ('description' in msg) {
        const description = { ...msg.description, sdp: tuneOpus(msg.description.sdp ?? '') };
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.sendSignal(from, { description: pc.localDescription.toJSON() } satisfies Signal);
        }
      } else if ('candidate' in msg) {
        await pc.addIceCandidate(msg.candidate).catch((e: unknown) => {
          if (!peer.ignoreOffer) throw e;
        });
      }
    } catch (e) {
      console.warn('voice signalling', e);
    }
  }

  async rttMs(): Promise<number | null> {
    const first = [...this.peers.values()].find((p) => p.pc.connectionState === 'connected');
    return first ? connectionRtt(first.pc) : null;
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.recovery);
    peer.pc.close();
    this.peers.delete(id);
    this.events.onRemoteGone(id);
  }

  close(): void {
    this.publish(null);
    for (const id of [...this.peers.keys()]) this.drop(id);
  }
}
