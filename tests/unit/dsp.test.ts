import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Biquad, BUTTERWORTH4_Q } from '../../src/client/modules/voice/dsp/biquad';
import { FRAME, SAMPLE_RATE, VoiceChain, type Denoiser } from '../../src/client/modules/voice/dsp/chain';
import { createRnnoise } from '../../src/client/modules/voice/dsp/rnnoise';
import { VoicingDetector } from '../../src/client/modules/voice/dsp/voicing';
import { DEFAULT_VOX, VoxGate } from '../../src/client/modules/voice/dsp/voxGate';
import { tuneOpus } from '../../src/client/modules/voice/sdp';

const sine = (hz: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const noise = (n: number, amp = 0.3) => {
  let s = 12345;
  return Float32Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32 - 0.5) * 2 * amp;
  });
};

function readSpeech(): Float32Array {
  const b = readFileSync('tests/fixtures/speech.wav');
  let p = 12;
  while (p < b.length) {
    const size = b.readUInt32LE(p + 4);
    if (b.toString('ascii', p, p + 4) === 'data') return Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(p + 8 + i * 2) / 32768);
    p += 8 + size + (size % 2);
  }
  throw new Error('no data');
}

describe('high-pass', () => {
  it('cuts wind rumble and passes speech', () => {
    const f = [new Biquad(), new Biquad()];
    f.forEach((b, i) => b.setHighpass(200, BUTTERWORTH4_Q[i] as number, SAMPLE_RATE));
    const run = (x: Float32Array) => x.map((v) => (f[1] as Biquad).process((f[0] as Biquad).process(v)));
    const rumble = run(sine(50, SAMPLE_RATE)).subarray(SAMPLE_RATE / 2);
    const voice = run(sine(1000, SAMPLE_RATE)).subarray(SAMPLE_RATE / 2);
    expect(20 * Math.log10(rms(rumble) / rms(sine(50, SAMPLE_RATE / 2)))).toBeLessThan(-40);
    expect(20 * Math.log10(rms(voice) / rms(sine(1000, SAMPLE_RATE / 2)))).toBeGreaterThan(-0.5);
  });
});

describe('voicing', () => {
  const score = (x: Float32Array) => {
    const d = new VoicingDetector();
    let v = 0;
    for (let i = 0; i + FRAME <= x.length; i += FRAME) v = d.process(x.subarray(i, i + FRAME));
    return v;
  };
  it('scores pitched sound high and noise low', () => {
    expect(score(sine(140, FRAME * 20))).toBeGreaterThan(0.9);
    expect(score(noise(FRAME * 20))).toBeLessThan(0.5);
  });
});

describe('VOX gate', () => {
  const open = (g: VoxGate, frames: number) => {
    let last = false;
    for (let i = 0; i < frames; i++) last = g.update(0.9, -20, 0, 0.9);
    return last;
  };
  it('needs both speech probability and pitch', () => {
    const g = new VoxGate();
    for (let i = 0; i < 50; i++) g.update(0.9, -20, 0.8, 0.2);
    expect(g.isOpen).toBe(false);
    for (let i = 0; i < 50; i++) g.update(0.05, -20, 0.8, 0.9);
    expect(g.isOpen).toBe(false);
  });
  it('ignores a single-frame blip', () => {
    const g = new VoxGate();
    g.update(0.9, -20, 0, 0.9);
    expect(g.update(0, -60, 0, 0)).toBe(false);
  });
  it('opens within 30 ms of speech', () => {
    expect(open(new VoxGate(), DEFAULT_VOX.attackFrames)).toBe(true);
  });
  it('rides through a pause, then closes', () => {
    const g = new VoxGate();
    open(g, 10);
    for (let i = 0; i < DEFAULT_VOX.hangoverFrames - 1; i++) expect(g.update(0, -60, 0, 0)).toBe(true);
    expect(g.update(0, -60, 0, 0)).toBe(false);
  });
  it('releases a constant drone that looks like a voice', () => {
    const g = new VoxGate();
    for (let i = 0; i < 20; i++) g.update(0.3, -60, 0, 0.1); // quiet first, so the floor is low
    let open = false;
    for (let i = 0; i < 1000; i++) open = g.update(0.9, -25, 0, 0.9); // engine: periodic, steady, loud
    expect(open).toBe(false);
  });
  it('holds longer in wind, when words get masked', () => {
    const calm = new VoxGate();
    const windy = new VoxGate();
    for (let i = 0; i < 10; i++) {
      calm.update(0.9, -20, 0, 0.9);
      windy.update(0.9, -20, 1, 0.9);
    }
    let calmFrames = 0;
    let windyFrames = 0;
    while (calm.update(0, -60, 0, 0)) calmFrames++;
    while (windy.update(0, -60, 1, 0)) windyFrames++;
    expect(windyFrames).toBeGreaterThan(calmFrames);
  });
});

describe('chain', () => {
  const quiet: Denoiser = { process: () => 0 };
  it('outputs digital silence while the gate is closed', () => {
    const c = new VoiceChain(quiet);
    const out = new Float32Array(FRAME).fill(1);
    const r = c.process(sine(300, FRAME), out);
    expect(r.transmit).toBe(false);
    expect(rms(out)).toBe(0);
  });
  it('transmits in push-to-talk only while held', () => {
    const c = new VoiceChain(quiet);
    c.mode = 'ptt';
    const out = new Float32Array(FRAME);
    expect(c.process(sine(300, FRAME), out).transmit).toBe(false);
    c.pttHeld = true;
    expect(c.process(sine(300, FRAME), out).transmit).toBe(true);
  });
  it('never transmits when muted', () => {
    const c = new VoiceChain({ process: () => 1 });
    c.mode = 'mute';
    const out = new Float32Array(FRAME);
    for (let i = 0; i < 50; i++) expect(c.process(sine(200, FRAME), out).transmit).toBe(false);
  });
  it('raises the high-pass with GPS speed before the mic hears wind', () => {
    const c = new VoiceChain(quiet);
    c.speedKmh = 120;
    const out = new Float32Array(FRAME);
    let cutoff = 0;
    for (let i = 0; i < 40; i++) cutoff = c.process(new Float32Array(FRAME), out).cutoffHz;
    expect(cutoff).toBeGreaterThan(200);
  });
  it('lets more of the dry signal through on a lighter noise filter', () => {
    const run = (filter: 'light' | 'strong') => {
      // A denoiser that removes everything, so all the output is the blended-in dry signal.
      const c = new VoiceChain({ process: (f) => (f.fill(0), 1) }, { raw: true });
      c.setNoiseFilter(filter);
      c.mode = 'open';
      const out = new Float32Array(FRAME);
      for (let i = 0; i < 40; i++) c.process(sine(600, FRAME, 0.3), out);
      return rms(out);
    };
    expect(run('light')).toBeGreaterThan(run('strong') * 3);
  });
  it('keeps output inside full scale on a loud input', () => {
    const c = new VoiceChain(quiet);
    c.mode = 'open';
    const out = new Float32Array(FRAME);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      c.process(sine(800, FRAME, 1), out);
      peak = Math.max(peak, ...out.map(Math.abs));
    }
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe('RNNoise binding', () => {
  const module = new WebAssembly.Module(readFileSync('node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm'));
  const speech = readSpeech();

  it('detects speech and is not stuck on its silent path', () => {
    const d = createRnnoise(module);
    const frame = new Float32Array(FRAME);
    let top = 0;
    for (let i = 0; i < 300; i++) {
      for (let j = 0; j < FRAME; j++) frame[j] = (speech[i * FRAME + j] as number) * 32768;
      top = Math.max(top, d.process(frame));
    }
    expect(top).toBeGreaterThan(0.9);
  });
  it('removes steady noise', () => {
    const d = createRnnoise(module);
    const input = noise(FRAME * 200, 0.05);
    const frame = new Float32Array(FRAME);
    let late = 0;
    for (let i = 0; i < 200; i++) {
      frame.set(input.subarray(i * FRAME, (i + 1) * FRAME).map((v) => v * 32768));
      d.process(frame);
      if (i > 150) late += rms(frame) / 32768;
    }
    expect(late / 49).toBeLessThan(rms(input) * 0.5);
  });
  it('lags exactly one frame, which the dry blend depends on', () => {
    const d = createRnnoise(module);
    const n = FRAME * 300;
    const wet = new Float32Array(n);
    const frame = new Float32Array(FRAME);
    for (let i = 0; i < n; i += FRAME) {
      frame.set(speech.subarray(i, i + FRAME).map((v) => v * 32768));
      d.process(frame);
      wet.set(frame.map((v) => v / 32768), i);
    }
    let bestLag = -1;
    let best = -Infinity;
    for (let lag = 0; lag <= 960; lag += 20) {
      let dot = 0;
      for (let i = 48000; i < n - 2000; i += 3) dot += (wet[i + lag] as number) * (speech[i] as number);
      if (dot > best) [best, bestLag] = [dot, lag];
    }
    expect(bestLag).toBe(FRAME);
  });
});

describe('Opus tuning', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0\r\n';
  it('enables FEC and DTX and caps the bitrate', () => {
    const out = tuneOpus(sdp);
    expect(out).toContain('useinbandfec=1');
    expect(out).toContain('usedtx=1');
    expect(out).toContain('maxaveragebitrate=24000');
    expect(out).toContain('maxplaybackrate=16000');
    expect(out).not.toContain('useinbandfec=0');
  });
  it('adds an fmtp line when none exists', () => {
    expect(tuneOpus('a=rtpmap:96 opus/48000/2\r\n')).toContain('a=fmtp:96 ');
  });
  it('leaves SDP without Opus alone', () => {
    expect(tuneOpus('m=video 9\r\n')).toBe('m=video 9\r\n');
  });
});
