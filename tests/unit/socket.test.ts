import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RideSocket } from '../../src/client/modules/ride/socket';

/** A socket under test control: it does nothing until told to. */
class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;

  constructor() {
    FakeSocket.made.push(this);
  }

  answer() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send() {}

  // Like a stuck connection, closing it does not promise a close event any time soon.
  close() {}
}

const noEvents = { addEventListener: () => undefined, removeEventListener: () => undefined };

describe('the ride socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', noEvents);
    vi.stubGlobal('document', { ...noEvents, visibilityState: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a connection that never answers, and tries again', () => {
    const states: string[] = [];
    const socket = new RideSocket('ws://x', () => undefined, (s) => states.push(s));
    expect(FakeSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.made.length).toBeGreaterThan(1);
    expect(states).toContain('retrying');
    socket.close();
  });

  it('gets back on as soon as a later attempt is answered', () => {
    const states: string[] = [];
    const socket = new RideSocket('ws://x', () => undefined, (s) => states.push(s));
    vi.advanceTimersByTime(60_000); // A long dead zone.
    FakeSocket.made.at(-1)?.answer();
    expect(states.at(-1)).toBe('live');
    socket.close();
  });

  it('leaves a working connection alone', () => {
    const socket = new RideSocket('ws://x', () => undefined, () => undefined);
    FakeSocket.made[0]?.answer();
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.made).toHaveLength(1);
    socket.close();
  });

  it('stops trying once the ride is left', () => {
    const socket = new RideSocket('ws://x', () => undefined, () => undefined);
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });
});
