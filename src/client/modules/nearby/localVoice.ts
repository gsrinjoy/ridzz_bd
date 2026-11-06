/**
 * Voice over the local radio link, where WebRTC is not available. Opus through
 * WebCodecs keeps packets small enough for a Bluetooth-grade connection.
 */
const SAMPLE_RATE = 48000;
const BITRATE = 24000;
/** A rider's first packet is played this far ahead, to ride out radio jitter. */
const JITTER_S = 0.08;

export const localVoiceSupported = () => 'AudioEncoder' in globalThis && 'AudioDecoder' in globalThis;

const OPUS_CONFIG = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 };

export class LocalEncoder {
  private readonly encoder: AudioEncoder;
  private timestamp = 0;

  constructor(onPacket: (data: Uint8Array) => void) {
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        onPacket(data);
      },
      error: (e) => console.warn('nearby encoder', e),
    });
    this.encoder.configure({ ...OPUS_CONFIG, bitrate: BITRATE });
  }

  /** Takes mono float samples at 48 kHz. */
  push(samples: Float32Array): void {
    const data = new AudioData({
      format: 'f32',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: samples.length,
      numberOfChannels: 1,
      timestamp: this.timestamp,
      data: samples as BufferSource,
    });
    this.timestamp += (samples.length / SAMPLE_RATE) * 1e6;
    this.encoder.encode(data);
    data.close();
  }

  close(): void {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

/** One per rider heard, because each stream has its own decoder state and timing. */
export class LocalPlayer {
  private readonly decoder: AudioDecoder;
  private nextAt = 0;
  private timestamp = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode,
  ) {
    this.decoder = new AudioDecoder({
      output: (audio) => this.play(audio),
      error: (e) => console.warn('nearby decoder', e),
    });
    this.decoder.configure(OPUS_CONFIG);
  }

  push(packet: Uint8Array): void {
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.timestamp, data: packet as BufferSource }));
    this.timestamp += 20_000;
  }

  private play(audio: AudioData): void {
    const frames = audio.numberOfFrames;
    const buffer = this.ctx.createBuffer(1, frames, audio.sampleRate);
    audio.copyTo(buffer.getChannelData(0), { planeIndex: 0, format: 'f32-planar' });
    audio.close();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    const now = this.ctx.currentTime;
    // Fallen behind, or just starting a sentence: restart the small cushion.
    if (this.nextAt < now) this.nextAt = now + JITTER_S;
    source.start(this.nextAt);
    this.nextAt += frames / audio.sampleRate;
  }

  close(): void {
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
