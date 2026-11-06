/** Mixes the speech fixture with road noise for use as a fake microphone. Usage: vite-node tests/audio/mix.ts <out.wav> <snrDb> <noise> */
import { readWav, writeWav } from './wav';
import { roadNoise, type NoiseName } from './road';

const [out, snr, noise] = process.argv.slice(2);
const speech = readWav('tests/fixtures/speech.wav');
const wind = roadNoise(noise as NoiseName, speech.length, 48000, 7);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const scale = (rms(speech.filter((v) => Math.abs(v) > 0.01)) / rms(wind)) * 10 ** (-Number(snr) / 20);
const mixed = speech.map((v, i) => v + (wind[i] as number) * scale);
const peak = mixed.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
writeWav(out as string, mixed.map((v) => (v / peak) * 0.9), 48000);
