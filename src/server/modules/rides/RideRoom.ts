import { DurableObject } from 'cloudflare:workers';
import { MAX_RIDERS, type AdminRider, type AlertKind, type ClientMessage, type LocTuple, type Position, type RideInfo, type RidePhase, type Rider, type ServerMessage, type Stop, type StopKind, type VoicePublication } from '../../../shared/protocol';
import { isValidLatLng } from '../../../shared/geo';
import type { Env } from '../../env';
import { directory } from '../directory/Directory';

/** Positions fan out in batches so each phone's radio wakes once per interval, not once per rider. */
const LOC_BATCH_MS = 3000;
const POSITION_PERSIST_MS = 60_000;
/** Usage is reported in batches, so that counting it costs almost nothing itself. */
const USAGE_FLUSH_MS = 60_000;
/** Cloudflare bills incoming socket messages at 20 to 1. */
const MESSAGES_PER_REQUEST = 20;
/** Opus at the capped bitrate, in GB per second of speech per listener. */
const VOICE_GB_PER_SECOND = 24_000 / 8 / 1e9;
/** Ride data is deleted this long after the last activity. */
const RETENTION_MS = 48 * 3600_000;

/** Far above any real message, including call setup, and low enough to stop abuse. */
const MAX_MESSAGE_CHARS = 32_000;

const STOP_KINDS: StopKind[] = ['start', 'fuel', 'food', 'rest', 'view', 'regroup', 'finish'];
const ALERT_KINDS: AlertKind[] = ['fuel', 'stop', 'regroup', 'hazard', 'sos'];

interface SocketTag {
  riderId: string;
}

/** One ride: all of its state, and the hub every rider's socket connects to. */
export class RideRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private info: RideInfo | undefined;
  private readonly riders = new Map<string, Rider>();
  private readonly pending = new Map<string, Position>();
  private readonly persistedAt = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private messages = 0;
  private rowsWritten = 0;
  private relayGb = 0;
  private usageFlushedAt = Date.now();
  private readonly talkingSince = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS riders (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, last_seen INTEGER NOT NULL, pos TEXT, voice TEXT);
      CREATE TABLE IF NOT EXISTS kicked (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS stops (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, name TEXT NOT NULL, la REAL NOT NULL, lo REAL NOT NULL, kind TEXT NOT NULL, added_by TEXT NOT NULL);
    `);
    this.load();
    // Keepalives are answered without waking this object, which is what makes hibernation free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private load(): void {
    const meta = this.sql.exec<{ key: string; value: string }>('SELECT key, value FROM meta').toArray();
    const get = (k: string) => meta.find((m) => m.key === k)?.value;
    const code = get('code');
    const name = get('name');
    const stamp = (key: string) => {
      const value = Number(get(key));
      return value ? value : undefined;
    };
    if (code && name) {
      const startsAt = stamp('starts_at');
      const startedAt = stamp('started_at');
      const endedAt = stamp('ended_at');
      this.info = {
        code,
        name,
        phase: (get('phase') as RidePhase | undefined) ?? 'planning',
        host: get('host') ?? '',
        ...(startsAt ? { startsAt } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
      };
    }

    const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as SocketTag).riderId));
    for (const r of this.sql.exec<{ id: string; name: string; color: string; last_seen: number; pos: string | null; voice: string | null }>('SELECT * FROM riders')) {
      this.riders.set(r.id, {
        id: r.id,
        name: r.name,
        color: r.color,
        online: online.has(r.id),
        talking: false,
        lastSeen: r.last_seen,
        ...(r.pos ? { pos: JSON.parse(r.pos) as Position } : {}),
        ...(r.voice ? { voice: JSON.parse(r.voice) as VoicePublication } : {}),
      });
    }
  }

  async create(code: string, name: string, host: string): Promise<void> {
    this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?), (?, ?), (?, ?), (?, ?)', 'code', code, 'name', name, 'host', host, 'phase', 'planning');
    this.info = { code, name, host, phase: 'planning' };
    await this.touch();
  }

  async join(id: string, name: string, color: string): Promise<'ok' | 'missing' | 'full' | 'kicked' | 'finished'> {
    if (!this.info) return 'missing';
    // A rider already on the ride may come back to see its summary; nobody new joins a finished ride.
    if (this.info.phase === 'finished' && !this.riders.has(id)) return 'finished';
    if (this.sql.exec('SELECT 1 FROM kicked WHERE id = ?', id).toArray().length) return 'kicked';
    if (this.riders.size >= MAX_RIDERS && !this.riders.has(id)) return 'full';
    // A rider coming back keeps their last position until a fresh fix arrives.
    const rider: Rider = { ...this.riders.get(id), id, name, color, online: false, talking: false, lastSeen: Date.now() };
    this.riders.set(id, rider);
    this.sql.exec('INSERT OR REPLACE INTO riders (id, name, color, last_seen) VALUES (?, ?, ?, ?)', id, name, color, rider.lastSeen);
    await this.touch();
    return 'ok';
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
  }

  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) return this.touch();
    await this.erase();
  }

  private async erase(): Promise<void> {
    const code = this.info?.code;
    await this.ctx.storage.deleteAll();
    this.info = undefined;
    this.riders.clear();
    if (code) await directory(this.env).removeRide(code);
  }

  /** The owner's view of this ride. */
  snapshot(): { phase: RidePhase; riders: AdminRider[]; stops: number } {
    const riders = [...this.riders.values()].map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      online: r.online,
      lastSeen: r.lastSeen,
      inCall: r.online && !!r.voice,
      ...(r.pos ? { pos: r.pos } : {}),
    }));
    return { phase: this.info?.phase ?? 'planning', riders, stops: this.sql.exec('SELECT 1 FROM stops').toArray().length };
  }

  async end(): Promise<void> {
    this.broadcast({ t: 'ended' });
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'ride ended');
    await this.erase();
  }

  kick(id: string): void {
    this.sql.exec('INSERT OR IGNORE INTO kicked VALUES (?)', id);
    this.sql.exec('DELETE FROM riders WHERE id = ?', id);
    for (const ws of this.ctx.getWebSockets(id)) {
      this.send(ws, { t: 'kicked' });
      ws.close(4002, 'removed');
    }
    this.riders.delete(id);
    this.pending.delete(id);
    // Everyone else needs to see them go.
    this.broadcast({ t: 'left', id });
  }

  override async fetch(request: Request): Promise<Response> {
    const riderId = new URL(request.url).searchParams.get('rider') ?? '';
    const rider = this.riders.get(riderId);
    if (!this.info || !rider) return new Response('unknown rider', { status: 404 });

    // A reconnecting phone often beats the server noticing the old socket died.
    for (const ws of this.ctx.getWebSockets(riderId)) ws.close(4000, 'replaced');

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [riderId]);
    server.serializeAttachment({ riderId } satisfies SocketTag);

    rider.online = true;
    rider.lastSeen = Date.now();
    this.send(server, { t: 'state', ride: this.info, you: riderId, riders: [...this.riders.values()], stops: this.stops() });
    this.broadcast({ t: 'rider', rider }, riderId);
    await this.touch();
    await directory(this.env).touchRide(this.info.code);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return;
    const tag = ws.deserializeAttachment() as SocketTag;
    const rider = this.riders.get(tag.riderId);
    if (!rider) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    this.handle(rider, msg);
  }

  private handle(rider: Rider, msg: ClientMessage): void {
    rider.lastSeen = Date.now();
    this.messages++;
    if (msg.t === 'talk') this.meterTalk(rider, !!msg.on);
    if (msg.t.startsWith('stop.')) this.rowsWritten++;
    if (Date.now() - this.usageFlushedAt > USAGE_FLUSH_MS) this.flushUsage();
    switch (msg.t) {
      case 'loc':
        return this.onLocation(rider, msg);
      case 'talk':
        rider.talking = !!msg.on;
        return this.broadcast({ t: 'talk', id: rider.id, on: rider.talking }, rider.id);
      case 'voice':
        if (msg.pub) rider.voice = msg.pub;
        else delete rider.voice;
        this.sql.exec('UPDATE riders SET voice = ? WHERE id = ?', msg.pub ? JSON.stringify(msg.pub) : null, rider.id);
        return this.broadcast({ t: 'rider', rider }, rider.id);
      case 'rtc':
        for (const peer of this.ctx.getWebSockets(msg.to)) this.send(peer, { t: 'rtc', from: rider.id, data: msg.data });
        return;
      case 'alert':
        if (!ALERT_KINDS.includes(msg.kind)) return;
        return this.broadcast({ t: 'alert', id: rider.id, kind: msg.kind, at: Date.now(), ...(rider.pos ? { pos: rider.pos } : {}) });
      case 'ride.update':
        return this.updateRide(msg);
      case 'ride.start':
        return this.setPhase(rider, 'planning', 'riding', 'started_at', 'startedAt');
      case 'ride.finish':
        return this.setPhase(rider, 'riding', 'finished', 'ended_at', 'endedAt');
      case 'stop.add':
        return this.addStop(rider, msg.stop);
      case 'stop.remove':
        this.sql.exec('DELETE FROM stops WHERE id = ?', msg.id);
        return this.broadcastStops();
      case 'stop.order':
        if (!Array.isArray(msg.ids) || msg.ids.length > 100) return;
        msg.ids.forEach((id, ord) => this.sql.exec('UPDATE stops SET ord = ? WHERE id = ?', ord, id));
        return this.broadcastStops();
    }
  }

  /** The host decides, but a dead phone must not strand the group, so anyone may if the host is away. */
  private canControl(rider: Rider): boolean {
    const host = this.info ? this.riders.get(this.info.host) : undefined;
    return rider.id === this.info?.host || !host?.online;
  }

  private setPhase(rider: Rider, from: RidePhase, to: RidePhase, key: string, field: 'startedAt' | 'endedAt'): void {
    if (this.info?.phase !== from || !this.canControl(rider)) return;
    const now = Date.now();
    this.info.phase = to;
    this.info[field] = now;
    this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?), (?, ?)', 'phase', to, key, String(now));
    this.broadcast({ t: 'ride', ride: this.info });
  }

  /** Relay egress is speech time multiplied by how many riders it fans out to. */
  private meterTalk(rider: Rider, on: boolean): void {
    if (on) {
      this.talkingSince.set(rider.id, Date.now());
      return;
    }
    const since = this.talkingSince.get(rider.id);
    this.talkingSince.delete(rider.id);
    if (!since || !this.env.SFU_APP_ID) return;
    const listeners = [...this.riders.values()].filter((r) => r.id !== rider.id && r.voice && r.online).length;
    this.relayGb += ((Date.now() - since) / 1000) * listeners * VOICE_GB_PER_SECOND;
  }

  private flushUsage(): void {
    const amounts = { do_requests: this.messages / MESSAGES_PER_REQUEST, rows_written: this.rowsWritten, relay_gb: this.relayGb };
    this.messages = this.rowsWritten = this.relayGb = 0;
    this.usageFlushedAt = Date.now();
    this.ctx.waitUntil(directory(this.env).addUsage(amounts));
  }

  private updateRide(msg: { name?: string; startsAt?: number | null }): void {
    if (!this.info) return;
    const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 40) : '';
    if (name) {
      this.info.name = name;
      this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', 'name', name);
      this.ctx.waitUntil(directory(this.env).renameRide(this.info.code, name));
    }
    if (msg.startsAt === null) {
      delete this.info.startsAt;
      this.sql.exec('DELETE FROM meta WHERE key = ?', 'starts_at');
    } else if (typeof msg.startsAt === 'number' && Number.isFinite(msg.startsAt)) {
      this.info.startsAt = msg.startsAt;
      this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', 'starts_at', String(msg.startsAt));
    }
    this.broadcast({ t: 'ride', ride: this.info });
  }

  private onLocation(rider: Rider, msg: Position): void {
    if (!isValidLatLng(msg.la, msg.lo)) return;
    const pos: Position = { la: msg.la, lo: msg.lo, sp: Number(msg.sp) || 0, hd: Number(msg.hd), ts: Date.now() };
    rider.pos = pos;
    this.pending.set(rider.id, pos);
    this.flushTimer ??= setTimeout(() => this.flushLocations(), LOC_BATCH_MS);

    // Per-update writes would exhaust the free tier's 100k rows a day; memory carries the live position.
    const last = this.persistedAt.get(rider.id) ?? 0;
    if (pos.ts - last > POSITION_PERSIST_MS) {
      this.persistedAt.set(rider.id, pos.ts);
      this.sql.exec('UPDATE riders SET pos = ?, last_seen = ? WHERE id = ?', JSON.stringify(pos), pos.ts, rider.id);
      this.rowsWritten++;
    }
  }

  private flushLocations(): void {
    this.flushTimer = undefined;
    const l: LocTuple[] = [...this.pending].map(([id, p]) => [id, p.la, p.lo, p.sp, p.hd, p.ts]);
    this.pending.clear();
    if (l.length) this.broadcast({ t: 'locs', l });
  }

  private addStop(rider: Rider, s: Omit<Stop, 'id' | 'addedBy'>): void {
    if (!s || !isValidLatLng(s.la, s.lo) || !STOP_KINDS.includes(s.kind)) return;
    const next = this.sql.exec<{ n: number }>('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM stops').one().n;
    this.sql.exec(
      'INSERT INTO stops (id, ord, name, la, lo, kind, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID().slice(0, 8), next, String(s.name).slice(0, 80) || 'Stop', s.la, s.lo, s.kind, rider.id,
    );
    this.broadcastStops();
  }

  private stops(): Stop[] {
    return this.sql
      .exec<{ id: string; name: string; la: number; lo: number; kind: string; added_by: string }>('SELECT * FROM stops ORDER BY ord')
      .toArray()
      .map((s) => ({ id: s.id, name: s.name, la: s.la, lo: s.lo, kind: s.kind as StopKind, addedBy: s.added_by }));
  }

  private broadcastStops(): void {
    this.broadcast({ t: 'stops', stops: this.stops() });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.onGone(ws);
    // Answer the close, or the rider's socket can sit in CLOSING instead of reconnecting.
    try {
      ws.close(1000);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket): void {
    const { riderId } = ws.deserializeAttachment() as SocketTag;
    const stillHere = this.ctx.getWebSockets(riderId).some((s) => s !== ws && s.readyState === WebSocket.OPEN);
    const rider = this.riders.get(riderId);
    if (stillHere || !rider) return;
    if (rider.talking) this.meterTalk(rider, false);
    rider.online = false;
    rider.talking = false;
    rider.lastSeen = Date.now();
    this.flushUsage();
    this.sql.exec('UPDATE riders SET last_seen = ?, pos = ? WHERE id = ?', rider.lastSeen, rider.pos ? JSON.stringify(rider.pos) : null, riderId);
    this.broadcast({ t: 'rider', rider });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is already gone; webSocketClose will tidy up.
    }
  }

  private broadcast(msg: ServerMessage, except?: string): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (except && (ws.deserializeAttachment() as SocketTag).riderId === except) continue;
      try {
        ws.send(text);
      } catch {
        // Same as above.
      }
    }
  }
}
