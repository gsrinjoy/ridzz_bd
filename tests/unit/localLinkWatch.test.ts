import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLinkWatch } from '../../src/client/modules/nearby/watch';

function setup() {
  const state = { on: false, starts: 0, stops: 0 };
  const watch = new LocalLinkWatch({
    running: () => state.on,
    start: () => {
      state.on = true;
      state.starts++;
    },
    stop: () => {
      state.on = false;
      state.stops++;
    },
  });
  return { state, watch };
}

/** A GPS fix each second re-runs the code that reports, whatever else is happening. */
function ride(watch: LocalLinkWatch, needed: boolean, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    watch.update(needed);
    vi.advanceTimersByTime(1000);
  }
}

describe('when the local link runs', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('starts even though GPS keeps reporting every second', () => {
    const { state, watch } = setup();
    ride(watch, true, 10);
    expect(state.starts).toBe(1);
  });

  it('stops after a good spell, even though GPS keeps reporting', () => {
    const { state, watch } = setup();
    ride(watch, true, 10);
    ride(watch, false, 40);
    expect(state.stops).toBe(1);
    expect(state.on).toBe(false);
  });

  it('ignores a blip too short to matter', () => {
    const { state, watch } = setup();
    ride(watch, true, 3);
    ride(watch, false, 10);
    expect(state.starts).toBe(0);
  });

  it('stays up through a short recovery', () => {
    const { state, watch } = setup();
    ride(watch, true, 10);
    ride(watch, false, 20);
    ride(watch, true, 5);
    ride(watch, false, 20);
    expect(state.stops).toBe(0);
  });

  it('can start again after leaving a call with the internet still down', () => {
    const { state, watch } = setup();
    ride(watch, true, 10);
    state.on = false;
    watch.reset();
    ride(watch, true, 10);
    expect(state.starts).toBe(2);
  });
});
