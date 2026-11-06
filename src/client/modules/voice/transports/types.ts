import type { Rider } from '../../../../shared/protocol';

export interface TransportEvents {
  onRemoteStream(riderId: string, stream: MediaStream): void;
  onRemoteGone(riderId: string): void;
  onHealth(state: 'live' | 'recovering', peers: number): void;
}

/** One way of carrying voice between riders. The engine neither knows nor cares which. */
export interface VoiceTransport {
  readonly kind: 'sfu' | 'mesh';
  start(track: MediaStreamTrack): Promise<void>;
  /** Called whenever the rider list changes. */
  syncRiders(riders: Rider[]): void;
  /** Stops sending entirely, so a closed gate costs no radio time. */
  setSending(on: boolean): void;
  signal?(from: string, data: unknown): void;
  rttMs(): Promise<number | null>;
  close(): void;
}

/** Applies active=on to a sender. Calls overlap during fast VOX flips, so only the latest wins. */
export class SenderGate {
  private desired = true;
  private busy = false;

  constructor(private readonly sender: RTCRtpSender) {}

  set(on: boolean): void {
    this.desired = on;
    if (!this.busy) void this.apply();
  }

  private async apply(): Promise<void> {
    this.busy = true;
    try {
      for (;;) {
        const params = this.sender.getParameters();
        const encoding = params.encodings[0];
        if (!encoding || encoding.active === this.desired) return;
        encoding.active = this.desired;
        await this.sender.setParameters(params);
      }
    } catch {
      // The connection closed mid-flight; the next one starts fresh.
    } finally {
      this.busy = false;
    }
  }
}

export async function connectionRtt(pc: RTCPeerConnection): Promise<number | null> {
  const stats = await pc.getStats();
  let rtt: number | null = null;
  stats.forEach((s: { type: string; state?: string; currentRoundTripTime?: number }) => {
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime !== undefined) {
      rtt = Math.round(s.currentRoundTripTime * 1000);
    }
  });
  return rtt;
}
