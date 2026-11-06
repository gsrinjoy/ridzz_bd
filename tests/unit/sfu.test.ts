import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SfuTransport, type SfuApi, type TracksResponse } from '../../src/client/modules/voice/transports/sfu';
import type { Rider, VoicePublication } from '../../src/shared/protocol';

// A stand-in for the browser's peer connection. Nothing here can prove the real
// Cloudflare service accepts these calls; it pins the sequence from their docs.
class FakePeerConnection {
  static last: FakePeerConnection;
  connectionState = 'connected';
  iceGatheringState = 'complete';
  localDescription: { sdp: string } | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  remote: { type: string; sdp?: string }[] = [];
  closed = false;
  constructor() {
    FakePeerConnection.last = this;
  }
  addTransceiver() {
    return { mid: '0', sender: { getParameters: () => ({ encodings: [{ active: true }] }), setParameters: async () => undefined } };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp?: string }) {
    this.remote.push(d);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

const rider = (id: string, sessionId = `s-${id}`): Rider => ({ id, name: id, color: '#fff', online: true, talking: false, lastSeen: 0, voice: { sessionId, trackName: `rider-${id}` } });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('SFU transport', () => {
  let calls: { op: string; body?: unknown }[];
  let api: SfuApi;
  let publish: ReturnType<typeof vi.fn<(pub: VoicePublication | null) => void>>;
  const events = { onRemoteStream: vi.fn(), onRemoteGone: vi.fn(), onHealth: vi.fn() };
  const track = {} as MediaStreamTrack;

  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    calls = [];
    publish = vi.fn<(pub: VoicePublication | null) => void>();
    let sessions = 0;
    api = {
      newSession: async () => {
        calls.push({ op: 'session' });
        return { sessionId: `mine-${++sessions}` };
      },
      tracks: async (_id, body) => {
        calls.push({ op: 'tracks', body });
        const b = body as { tracks: { location: string; trackName: string }[] };
        if (b.tracks[0]?.location === 'local') return { sessionDescription: { type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' } } as TracksResponse;
        return { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'pull-offer' }, tracks: [{ mid: '1' }] };
      },
      renegotiate: async (_id, body) => {
        calls.push({ op: 'renegotiate', body });
        return {};
      },
    };
  });

  const start = async () => {
    const t = new SfuTransport('me', [], api, publish, events);
    await t.start(track);
    return t;
  };

  it('publishes with the offer and local mid, then announces the track', async () => {
    await start();
    expect(calls[0]).toEqual({ op: 'session' });
    expect(calls[1]?.body).toMatchObject({ sessionDescription: { type: 'offer', sdp: 'offer-sdp' }, tracks: [{ location: 'local', mid: '0', trackName: 'rider-me' }] });
    expect(publish).toHaveBeenCalledWith({ sessionId: 'mine-1', trackName: 'rider-me' });
  });

  it('applies Opus tuning to the answer', async () => {
    await start();
    expect(FakePeerConnection.last.remote[0]?.sdp).toContain('usedtx=1');
  });

  it('pulls a remote track and answers its offer through renegotiate', async () => {
    const t = await start();
    t.syncRiders([rider('a')]);
    await flush();
    const pull = calls.find((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote');
    expect(pull?.body).toEqual({ tracks: [{ location: 'remote', sessionId: 's-a', trackName: 'rider-a' }] });
    expect(calls.at(-1)).toEqual({ op: 'renegotiate', body: { sessionDescription: { type: 'answer', sdp: 'answer-sdp' } } });
  });

  it('does not pull the same publication twice, or its own', async () => {
    const t = await start();
    t.syncRiders([rider('a'), rider('me')]);
    t.syncRiders([rider('a'), rider('me')]);
    await flush();
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(1);
  });

  it('pulls again when a rider reconnects on a new session', async () => {
    const t = await start();
    t.syncRiders([rider('a', 'first')]);
    await flush();
    t.syncRiders([rider('a', 'second')]);
    await flush();
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(2);
  });

  it('rebuilds the session by itself when the connection fails', async () => {
    const t = await start();
    t.syncRiders([rider('a')]);
    await flush();
    const dead = FakePeerConnection.last;
    dead.connectionState = 'failed';
    dead.onconnectionstatechange?.();
    await flush();
    await flush();
    expect(dead.closed).toBe(true);
    expect(calls.filter((c) => c.op === 'session')).toHaveLength(2);
    expect(publish).toHaveBeenLastCalledWith({ sessionId: 'mine-2', trackName: 'rider-me' });
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(2);
  });

  it('retries a pull that failed, so no rider stays silent', async () => {
    vi.useFakeTimers();
    const t = await start();
    const real = api.tracks;
    let failures = 1;
    api.tracks = async (id, body) => {
      if (failures-- > 0) throw new Error('busy');
      return real(id, body);
    };
    t.syncRiders([rider('a')]);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_100);
    vi.useRealTimers();
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(1);
  });

  it('ignores riders who have already moved to direct links', async () => {
    const t = await start();
    t.syncRiders([{ ...rider('a'), voice: { sessionId: 'x', trackName: 'mesh' } }]);
    await flush();
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(0);
  });

  it('keeps a pull through a control-socket blip', async () => {
    const t = await start();
    t.syncRiders([rider('a')]);
    await flush();
    events.onRemoteGone.mockClear();
    t.syncRiders([{ ...rider('a'), online: false }]);
    await flush();
    expect(events.onRemoteGone).not.toHaveBeenCalled();
  });

  it('drops a pull when the rider leaves the call', async () => {
    const t = await start();
    t.syncRiders([rider('a')]);
    await flush();
    const { voice: _gone, ...left } = rider('a');
    t.syncRiders([left]);
    await flush();
    expect(events.onRemoteGone).toHaveBeenCalledWith('a');
  });

  it('does not pull while still publishing, which would corrupt the handshake', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = api.tracks;
    api.tracks = async (id, body) => {
      await gate;
      return real(id, body);
    };
    const t = new SfuTransport('me', [], api, publish, events);
    const starting = t.start(track);
    await flush();
    t.syncRiders([rider('a')]); // A rider appears mid-handshake.
    await flush();
    expect(calls.filter((c) => (c.body as { tracks?: { location: string }[] })?.tracks?.[0]?.location === 'remote')).toHaveLength(0);
    release();
    await starting;
    await flush();
    await flush();
    const order = calls.filter((c) => c.op === 'tracks').map((c) => (c.body as { tracks: { location: string }[] }).tracks[0]?.location);
    expect(order).toEqual(['local', 'remote']);
  });

  it('keeps retrying after a failed start instead of giving up', async () => {
    vi.useFakeTimers();
    const real = api.tracks;
    let failures = 2;
    api.tracks = async (id, body) => {
      if (failures-- > 0) return { tracks: [{ errorCode: 'not_found' }] };
      return real(id, body);
    };
    await start();
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ trackName: 'rider-me' }));
  });
});
