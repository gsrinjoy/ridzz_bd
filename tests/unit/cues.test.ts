import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CueDirector, LINK_QUIET_MS, LINK_REPEAT_MS, RIDER_GAP_MS, RIDER_GRACE_MS } from '../../src/client/modules/voice/cueDirector';
import { CUES, type Cue } from '../../src/client/modules/voice/cues';

describe('cue sounds', () => {
  const length = (c: Cue) => CUES[c].notes.reduce((n, [, ms]) => n + ms + 30, 0);
  const everyday: Cue[] = ['call-join', 'call-leave', 'rider-join', 'rider-leave', 'reconnecting', 'reconnected', 'call-cut', 'mute', 'unmute'];
  const rising = (c: Cue) => (CUES[c].notes.at(-1) as [number, number])[0] > (CUES[c].notes[0] as [number, number])[0];

  it('keeps everyday cues short', () => {
    for (const c of everyday) expect(length(c), c).toBeLessThanOrEqual(450);
  });
  it('keeps everyday cues quieter than alerts', () => {
    for (const c of everyday) expect(CUES[c].level, c).toBeLessThan(CUES.alert.level);
  });
  it('rises for arrivals and falls for departures', () => {
    for (const c of ['call-join', 'rider-join', 'reconnected'] as Cue[]) expect(rising(c), c).toBe(true);
    for (const c of ['call-leave', 'rider-leave', 'call-cut'] as Cue[]) expect(rising(c), c).toBe(false);
  });
  it('marks the start and end of a ride with a longer phrase, up and then down', () => {
    expect(CUES['ride-start'].notes).toHaveLength(4);
    expect(rising('ride-start')).toBe(true);
    expect(rising('ride-end')).toBe(false);
  });
  it('gives each cue its own sound', () => {
    const shapes = Object.values(CUES).map((c) => JSON.stringify(c.notes));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
  it('uses three notes for the connection and two for people', () => {
    expect(CUES.reconnected.notes).toHaveLength(3);
    expect(CUES['call-cut'].notes).toHaveLength(3);
    expect(CUES['rider-join'].notes).toHaveLength(2);
    expect(CUES['rider-leave'].notes).toHaveLength(2);
  });
});

describe('cue director', () => {
  let played: Cue[];
  let director: CueDirector;

  beforeEach(() => {
    vi.useFakeTimers();
    played = [];
    director = new CueDirector((c) => played.push(c));
  });

  it('stays silent through a short network blip', () => {
    director.setLink(false);
    vi.advanceTimersByTime(LINK_QUIET_MS - 100);
    director.setLink(true);
    vi.advanceTimersByTime(60_000);
    expect(played).toEqual([]);
  });
  it('announces a real drop and its recovery', () => {
    director.setLink(false);
    vi.advanceTimersByTime(LINK_QUIET_MS);
    director.setLink(true);
    expect(played).toEqual(['reconnecting', 'reconnected']);
  });
  it('reminds gently during a long outage, and only then', () => {
    director.setLink(false);
    vi.advanceTimersByTime(LINK_QUIET_MS + LINK_REPEAT_MS * 2);
    expect(played).toEqual(['reconnecting', 'reconnecting', 'reconnecting']);
  });
  it('ignores a repeated state report', () => {
    director.setLink(true);
    director.setLink(true);
    expect(played).toEqual([]);
  });
  it('plays one sound when riders arrive together', () => {
    director.riderJoined('a');
    director.riderJoined('b');
    director.riderJoined('c');
    expect(played).toEqual(['rider-join']);
    vi.advanceTimersByTime(RIDER_GAP_MS);
    director.riderJoined('d');
    expect(played).toEqual(['rider-join', 'rider-join']);
  });
  it('says nothing when a rider drops and returns', () => {
    director.riderLeft('a', true);
    vi.advanceTimersByTime(RIDER_GRACE_MS - 100);
    director.riderJoined('a');
    vi.advanceTimersByTime(60_000);
    expect(played).toEqual([]);
  });
  it('announces a rider who really is gone, after the grace period', () => {
    director.riderLeft('a', true);
    expect(played).toEqual([]);
    vi.advanceTimersByTime(RIDER_GRACE_MS);
    expect(played).toEqual(['rider-leave']);
  });
  it('announces pressing End at once', () => {
    director.riderLeft('a', false);
    expect(played).toEqual(['rider-leave']);
  });
  it('stops all pending sounds when the call ends', () => {
    director.setLink(false);
    director.riderLeft('a', true);
    director.destroy();
    vi.advanceTimersByTime(60_000);
    expect(played).toEqual([]);
  });
});
