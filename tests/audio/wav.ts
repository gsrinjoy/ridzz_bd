import { readFileSync, writeFileSync } from 'node:fs';

/** Reads the data chunk of a 16-bit mono WAV as floats. */
export function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  let p = 12;
  while (p < b.length) {
    const size = b.readUInt32LE(p + 4);
    if (b.toString('ascii', p, p + 4) === 'data') {
      const s = new Float32Array(size / 2);
      for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return s;
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

export function writeWav(path: string, x: ArrayLike<number>, sampleRate: number): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i] as number)) * 32767), 44 + i * 2);
  }
  writeFileSync(path, b);
}
