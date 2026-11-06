/**
 * Status sounds for riders who cannot look at the screen. Synthesised, so there
 * is nothing to download, and played to this rider only, never on air.
 *
 * The sound language: rising means someone or something arrived, falling means
 * it left. Two notes are about people, three about the connection.
 */
export type Cue =
  | 'call-join'
  | 'call-leave'
  | 'call-cut'
  | 'ride-start'
  | 'ride-end'
  | 'rider-join'
  | 'rider-leave'
  | 'reconnecting'
  | 'reconnected'
  | 'mute'
  | 'unmute'
  | 'alert'
  | 'sos'
  | 'test';

export interface CueSound {
  /** [frequency in Hz, duration in ms] */
  notes: [number, number][];
  level: number;
}

export const CUES: Record<Cue, CueSound> = {
  'call-join': { notes: [[523, 90], [784, 150]], level: 0.14 },
  'call-leave': { notes: [[784, 90], [523, 150]], level: 0.14 },
  'rider-join': { notes: [[659, 70], [880, 100]], level: 0.1 },
  'rider-leave': { notes: [[880, 70], [659, 100]], level: 0.1 },
  reconnecting: { notes: [[440, 60], [440, 60]], level: 0.09 },
  reconnected: { notes: [[523, 70], [659, 70], [784, 120]], level: 0.12 },
  'call-cut': { notes: [[659, 100], [494, 100], [330, 150]], level: 0.16 },
  'ride-start': { notes: [[392, 110], [523, 110], [659, 110], [784, 180]], level: 0.16 },
  'ride-end': { notes: [[784, 110], [659, 110], [523, 110], [392, 180]], level: 0.16 },
  mute: { notes: [[330, 50]], level: 0.08 },
  unmute: { notes: [[494, 50]], level: 0.08 },
  alert: { notes: [[880, 120], [880, 120]], level: 0.22 },
  sos: { notes: [[1100, 180], [800, 180], [1100, 180], [800, 180]], level: 0.3 },
  test: { notes: [[523, 130], [659, 130], [784, 200]], level: 0.2 },
};

const GAP_S = 0.03;
const EDGE_S = 0.012; // Soft edges: a hard start clicks in a helmet speaker.

export function playCue(ctx: AudioContext, cue: Cue, destination: AudioNode = ctx.destination): void {
  const { notes, level } = CUES[cue];
  let at = ctx.currentTime + 0.01;
  for (const [freq, ms] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const end = at + ms / 1000;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + EDGE_S);
    gain.gain.setValueAtTime(level, end - EDGE_S * 2);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain).connect(destination);
    osc.start(at);
    osc.stop(end);
    at = end + GAP_S;
  }
}

/** iPhones only speak after speech has been started from a tap, so this runs in one. */
export function unlockSpeech(): void {
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

export function speak(text: string): void {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}
