import type { ClientMessage, ServerMessage } from '../../../shared/protocol';

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 8_000;
/**
 * A connection tried with no signal can sit unanswered for minutes without failing.
 * Waiting it out would keep a rider off the call long after the signal came back.
 */
const CONNECT_TIMEOUT_MS = 7_000;

/**
 * The ride's control channel. It never gives up: riders cannot touch the phone,
 * so every drop is retried until the ride is left.
 */
export class RideSocket {
  private ws: WebSocket | undefined;
  private attempts = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private pongDue: ReturnType<typeof setTimeout> | undefined;
  private connectDue: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: 'live' | 'retrying') => void,
  ) {
    window.addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.onVisible);
    this.open();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    window.removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stopTimers();
    clearTimeout(this.retry);
    this.ws?.close();
  }

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.ws?.readyState !== WebSocket.OPEN) this.reconnectNow();
  };

  private readonly reconnectNow = () => {
    if (this.closed) return;
    clearTimeout(this.retry);
    this.attempts = 0;
    this.open();
  };

  private open(): void {
    this.ws?.close();
    clearTimeout(this.connectDue);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connectDue = setTimeout(() => {
      this.lost(ws);
      ws.close();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(this.connectDue);
      this.attempts = 0;
      this.onState('live');
      this.startPing(ws);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') {
        clearTimeout(this.pongDue);
        return;
      }
      this.onMessage(JSON.parse(e.data as string) as ServerMessage);
    };
    ws.onclose = () => this.lost(ws);
  }

  /** Reconnects now. On a dead network, onclose can take a long time to fire, so nothing waits for it. */
  private lost(ws: WebSocket): void {
    if (ws !== this.ws || this.closed) return;
    this.ws = undefined;
    this.stopTimers();
    this.onState('retrying');
    const backoff = Math.min(MAX_BACKOFF_MS, 400 * 2 ** this.attempts++);
    this.retry = setTimeout(() => this.open(), backoff * (0.7 + Math.random() * 0.6));
  }

  private startPing(ws: WebSocket): void {
    this.stopTimers();
    this.ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send('ping');
      // A silent network does not fire onclose, so detect it here.
      this.pongDue = setTimeout(() => {
        this.lost(ws);
        ws.close();
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  private stopTimers(): void {
    clearInterval(this.ping);
    clearTimeout(this.pongDue);
    clearTimeout(this.connectDue);
  }
}
