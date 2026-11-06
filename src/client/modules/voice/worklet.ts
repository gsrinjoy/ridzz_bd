import { FRAME, VoiceChain, type NoiseFilter, type TalkMode } from './dsp/chain';
import { createRnnoise } from './dsp/rnnoise';

// The AudioWorklet global scope is not in TypeScript's DOM library.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: unknown): void;

const QUANTUM = 128;
const FIFO = 2048;
const METER_EVERY = 20; // frames, so 5 Hz

export type WorkletCommand =
  | { type: 'mode'; mode: TalkMode }
  | { type: 'ptt'; held: boolean }
  | { type: 'speed'; kmh: number }
  | { type: 'sensitivity'; value: number }
  | { type: 'noiseFilter'; filter: NoiseFilter }
  | { type: 'meters'; on: boolean }
  | { type: 'tap'; on: boolean };

export type WorkletEvent =
  | { type: 'tx'; on: boolean }
  | { type: 'meter'; level: number; wind: number; speech: number }
  | { type: 'pcm'; samples: Float32Array };

class VoiceProcessor extends AudioWorkletProcessor {
  private readonly chain: VoiceChain;
  private readonly frame = new Float32Array(FRAME);
  private readonly out = new Float32Array(FRAME);
  private readonly fifo = new Float32Array(FIFO);
  private filled = 0;
  private read = 0;
  private write = 0;
  private available = 0;
  private frames = 0;
  private transmitting = false;
  private meters = false;
  private tap = false;

  constructor(options: { processorOptions: { wasm: ArrayBuffer } }) {
    super();
    const module = new WebAssembly.Module(options.processorOptions.wasm);
    this.chain = new VoiceChain(createRnnoise(module));
    this.port.onmessage = (e: MessageEvent<WorkletCommand>) => this.command(e.data);
  }

  private command(c: WorkletCommand): void {
    switch (c.type) {
      case 'mode':
        this.chain.mode = c.mode;
        break;
      case 'ptt':
        this.chain.pttHeld = c.held;
        break;
      case 'speed':
        this.chain.speedKmh = c.kmh;
        break;
      case 'sensitivity':
        // Lower pitch bar means easier to open, and more noise gets through.
        this.chain.setVox({ voicingMin: 0.5 - c.value * 0.2 });
        break;
      case 'noiseFilter':
        this.chain.setNoiseFilter(c.filter);
        break;
      case 'meters':
        this.meters = c.on;
        break;
      case 'tap':
        this.tap = c.on;
        break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    for (let i = 0; i < QUANTUM; i++) {
      this.frame[this.filled++] = input ? (input[i] as number) : 0;
      if (this.filled === FRAME) {
        this.filled = 0;
        this.runFrame();
      }
    }
    if (output && this.available >= QUANTUM) {
      for (let i = 0; i < QUANTUM; i++) {
        output[i] = this.fifo[this.read] as number;
        this.read = (this.read + 1) % FIFO;
      }
      this.available -= QUANTUM;
    }
    return true;
  }

  private runFrame(): void {
    const r = this.chain.process(this.frame, this.out);
    for (let i = 0; i < FRAME; i++) {
      this.fifo[this.write] = this.out[i] as number;
      this.write = (this.write + 1) % FIFO;
    }
    this.available = Math.min(FIFO, this.available + FRAME);
    if (r.transmit !== this.transmitting) {
      this.transmitting = r.transmit;
      this.port.postMessage({ type: 'tx', on: r.transmit } satisfies WorkletEvent);
    }
    if (this.tap && r.transmit) {
      const samples = this.out.slice();
      this.port.postMessage({ type: 'pcm', samples } satisfies WorkletEvent, [samples.buffer]);
    }
    if (this.meters && ++this.frames % METER_EVERY === 0) {
      this.port.postMessage({ type: 'meter', level: r.levelDb, wind: r.wind, speech: r.probability } satisfies WorkletEvent);
    }
  }
}

registerProcessor('slipstream-voice', VoiceProcessor);
