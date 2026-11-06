import { DurableObject } from 'cloudflare:workers';
import type { AdminUser, FriendInfo, FriendRequest, FriendsView, RideInvite } from '../../../shared/protocol';
import type { RideLog, RideSummary } from '../../../shared/stats';
import type { Env } from '../../env';
import { digest, DUMMY_HASH_INPUT, hashSecret, newRecoveryCode, newSessionToken, normaliseCode, verifySecret } from '../auth/passwords';
import { newRideCode } from '../rides/auth';

export type UserRow = {
  id: string;
  name: string;
  color: string;
  friend_code: string;
  created_at: number;
  last_seen: number;
  blocked: number;
};

type CredentialRow = {
  user_id: string;
  email: string;
  password: string;
  recovery: string;
};

export type RideRow = {
  code: string;
  name: string;
  owner: string;
  created_at: number;
  last_active: number;
};

const SESSION_MS = 60 * 24 * 3600_000;
const SEEN_EVERY_MS = 5 * 60_000;

const toFriend = (u: UserRow): FriendInfo => ({ id: u.id, name: u.name, color: u.color, friendCode: u.friend_code });

/** Friendships are stored once, lowest id first, so one row answers both directions. */
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

/** Everything that outlives a single ride: people, friendships, invites, and the list of rides. */
export class Directory extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, friend_code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, recovery TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS friendships (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, UNIQUE (from_id, to_id));
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, code TEXT NOT NULL, UNIQUE (to_id, code));
      CREATE TABLE IF NOT EXISTS ride_logs (user_id TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (user_id, id));
      CREATE TABLE IF NOT EXISTS rides (code TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
    `);
  }

  private user(id: string): UserRow | undefined {
    return this.sql.exec<UserRow>('SELECT * FROM users WHERE id = ?', id).toArray()[0];
  }

  private createUser(name: string, color: string): UserRow {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = Date.now();
    for (;;) {
      const code = newRideCode();
      if (this.sql.exec('SELECT 1 FROM users WHERE friend_code = ?', code).toArray().length) continue;
      this.sql.exec('INSERT INTO users (id, name, color, friend_code, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)', id, name, color, code, now, now);
      return this.user(id) as UserRow;
    }
  }

  private credentials(email: string): CredentialRow | undefined {
    return this.sql.exec<CredentialRow>('SELECT * FROM credentials WHERE email = ?', email).toArray()[0];
  }

  private async openSession(userId: string): Promise<string> {
    const token = newSessionToken();
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', await digest(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  private endSessions(userId: string): void {
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  async register(name: string, color: string, email: string, password: string): Promise<{ user: UserRow; token: string; recoveryCode: string } | null> {
    if (this.credentials(email)) return null;
    const recoveryCode = newRecoveryCode();
    const [hash, recovery] = await Promise.all([hashSecret(password), hashSecret(recoveryCode)]);
    // Checked again: two sign-ups can both pass the first check while hashing.
    if (this.credentials(email)) return null;
    const user = this.createUser(name, color);
    this.sql.exec('INSERT INTO credentials VALUES (?, ?, ?, ?)', user.id, email, hash, recovery);
    return { user, token: await this.openSession(user.id), recoveryCode };
  }

  async login(email: string, password: string): Promise<{ user: UserRow; token: string } | null> {
    const found = this.credentials(email);
    if (!found) {
      await hashSecret(DUMMY_HASH_INPUT); // Same effort as a real check, so timing reveals nothing.
      return null;
    }
    if (!(await verifySecret(password, found.password))) return null;
    const user = this.user(found.user_id) as UserRow;
    return { user, token: await this.openSession(user.id) };
  }

  async authenticate(token: string): Promise<UserRow | undefined> {
    const row = this.sql.exec<{ user_id: string; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', await digest(token)).toArray()[0];
    if (!row || row.expires_at < Date.now()) return undefined;
    const user = this.user(row.user_id);
    if (user && Date.now() - user.last_seen > SEEN_EVERY_MS) {
      this.sql.exec('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), user.id);
    }
    return user;
  }

  async logout(token: string): Promise<void> {
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await digest(token));
  }

  /** A password change signs out every device, in case the old one was stolen. */
  async changePassword(userId: string, current: string, next: string): Promise<string | null> {
    const row = this.sql.exec<CredentialRow>('SELECT * FROM credentials WHERE user_id = ?', userId).toArray()[0];
    if (!row || !(await verifySecret(current, row.password))) return null;
    this.sql.exec('UPDATE credentials SET password = ? WHERE user_id = ?', await hashSecret(next), userId);
    this.endSessions(userId);
    return this.openSession(userId);
  }

  /** Each recovery code works once. A new one is issued with the new password. */
  async recover(email: string, code: string, next: string): Promise<{ user: UserRow; token: string; recoveryCode: string } | null> {
    const found = this.credentials(email);
    if (!found) {
      await hashSecret(DUMMY_HASH_INPUT);
      return null;
    }
    if (!(await verifySecret(normaliseCode(code), found.recovery))) return null;
    const recoveryCode = newRecoveryCode();
    const [hash, recovery] = await Promise.all([hashSecret(next), hashSecret(recoveryCode)]);
    this.sql.exec('UPDATE credentials SET password = ?, recovery = ? WHERE user_id = ?', hash, recovery, found.user_id);
    this.endSessions(found.user_id);
    const user = this.user(found.user_id) as UserRow;
    return { user, token: await this.openSession(user.id), recoveryCode };
  }

  /** For a rider who lost both password and recovery code. Hands back a one-off password. */
  async ownerResetPassword(userId: string): Promise<string | null> {
    if (!this.user(userId)) return null;
    const temporary = newRecoveryCode();
    this.sql.exec('UPDATE credentials SET password = ? WHERE user_id = ?', await hashSecret(temporary), userId);
    this.endSessions(userId);
    return temporary;
  }

  /** Counts one attempt and says whether it is within the limit. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql.exec<{ count: number; reset_at: number }>('SELECT count, reset_at FROM attempts WHERE key = ?', key).toArray()[0];
    if (!row || row.reset_at < now) {
      this.sql.exec('INSERT OR REPLACE INTO attempts VALUES (?, 1, ?)', key, now + windowMs);
      return true;
    }
    if (row.count >= limit) return false;
    this.sql.exec('UPDATE attempts SET count = count + 1 WHERE key = ?', key);
    return true;
  }

  clearAttempts(key: string): void {
    this.sql.exec('DELETE FROM attempts WHERE key = ?', key);
  }

  getUser(id: string): UserRow | undefined {
    return this.user(id);
  }

  updateUser(id: string, name: string, color: string): void {
    this.sql.exec('UPDATE users SET name = ?, color = ? WHERE id = ?', name, color, id);
  }

  private areFriends(a: string, b: string): boolean {
    const [x, y] = pair(a, b);
    return this.sql.exec('SELECT 1 FROM friendships WHERE a = ? AND b = ?', x, y).toArray().length > 0;
  }

  private befriend(a: string, b: string): void {
    const [x, y] = pair(a, b);
    this.sql.exec('INSERT OR IGNORE INTO friendships VALUES (?, ?)', x, y);
    this.sql.exec('DELETE FROM requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', a, b, b, a);
  }

  /** Target is a friend code, or a user id for someone met on a ride. */
  requestFriend(fromId: string, target: string): 'sent' | 'friends' | 'self' | 'unknown' {
    const to = this.sql.exec<UserRow>('SELECT * FROM users WHERE friend_code = ? OR id = ?', target, target).toArray()[0];
    if (!to || to.blocked) return 'unknown';
    if (to.id === fromId) return 'self';
    if (this.areFriends(fromId, to.id)) return 'friends';
    // They already asked: asking back is the same as accepting.
    if (this.sql.exec('SELECT 1 FROM requests WHERE from_id = ? AND to_id = ?', to.id, fromId).toArray().length) {
      this.befriend(fromId, to.id);
      return 'friends';
    }
    this.sql.exec('INSERT OR IGNORE INTO requests VALUES (?, ?, ?)', crypto.randomUUID().slice(0, 12), fromId, to.id);
    return 'sent';
  }

  respond(userId: string, requestId: string, accept: boolean): boolean {
    const row = this.sql.exec<{ from_id: string; to_id: string }>('SELECT from_id, to_id FROM requests WHERE id = ?', requestId).toArray()[0];
    // Only the person asked may answer, and the sender may withdraw.
    if (!row || (row.to_id !== userId && !(row.from_id === userId && !accept))) return false;
    if (accept) this.befriend(row.from_id, row.to_id);
    else this.sql.exec('DELETE FROM requests WHERE id = ?', requestId);
    return true;
  }

  removeFriend(userId: string, friendId: string): void {
    const [x, y] = pair(userId, friendId);
    this.sql.exec('DELETE FROM friendships WHERE a = ? AND b = ?', x, y);
  }

  inviteToRide(fromId: string, toId: string, code: string): boolean {
    if (!this.areFriends(fromId, toId)) return false;
    this.sql.exec('INSERT OR REPLACE INTO invites VALUES (?, ?, ?, ?)', crypto.randomUUID().slice(0, 12), fromId, toId, code);
    return true;
  }

  dismissInvite(userId: string, id: string): void {
    this.sql.exec('DELETE FROM invites WHERE id = ? AND to_id = ?', id, userId);
  }

  friends(userId: string): FriendsView {
    const friends = this.sql
      .exec<UserRow>('SELECT u.* FROM friendships f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE f.a = ? OR f.b = ? ORDER BY u.name', userId, userId, userId)
      .toArray()
      .map(toFriend);
    const requests = (column: 'from_id' | 'to_id', other: 'from_id' | 'to_id'): FriendRequest[] =>
      this.sql
        .exec<UserRow & { request_id: string }>(`SELECT u.*, r.id AS request_id FROM requests r JOIN users u ON u.id = r.${other} WHERE r.${column} = ?`, userId)
        .toArray()
        .map((u) => ({ ...toFriend(u), requestId: u.request_id }));
    const invites = this.sql
      .exec<{ id: string; code: string; name: string }>('SELECT i.id, i.code, u.name FROM invites i JOIN users u ON u.id = i.from_id JOIN rides r ON r.code = i.code WHERE i.to_id = ?', userId)
      .toArray()
      .map((i): RideInvite => ({ inviteId: i.id, code: i.code, from: i.name }));
    return { friends, incoming: requests('to_id', 'from_id'), outgoing: requests('from_id', 'to_id'), invites };
  }

  /** Replaces any earlier upload of the same ride and day, so a retry cannot double-count. */
  saveLog(userId: string, log: RideLog): void {
    const { bands: _b, intervals: _i, track: _t, ...summary } = log;
    this.sql.exec('INSERT OR REPLACE INTO ride_logs VALUES (?, ?, ?, ?, ?)', userId, log.id, log.date, JSON.stringify(summary), JSON.stringify(log));
  }

  listLogs(userId: string): RideSummary[] {
    return this.sql
      .exec<{ summary: string }>('SELECT summary FROM ride_logs WHERE user_id = ? ORDER BY date DESC', userId)
      .toArray()
      .map((r) => JSON.parse(r.summary) as RideSummary);
  }

  getLog(userId: string, id: string): RideLog | undefined {
    const row = this.sql.exec<{ detail: string }>('SELECT detail FROM ride_logs WHERE user_id = ? AND id = ?', userId, id).toArray()[0];
    return row ? (JSON.parse(row.detail) as RideLog) : undefined;
  }

  registerRide(code: string, name: string, owner: string): void {
    const now = Date.now();
    this.sql.exec('INSERT OR REPLACE INTO rides VALUES (?, ?, ?, ?, ?)', code, name, owner, now, now);
  }

  renameRide(code: string, name: string): void {
    this.sql.exec('UPDATE rides SET name = ? WHERE code = ?', name, code);
  }

  touchRide(code: string): void {
    this.sql.exec('UPDATE rides SET last_active = ? WHERE code = ?', Date.now(), code);
  }

  removeRide(code: string): void {
    this.sql.exec('DELETE FROM rides WHERE code = ?', code);
    this.sql.exec('DELETE FROM invites WHERE code = ?', code);
  }

  listRides(): RideRow[] {
    return this.sql.exec<RideRow>('SELECT * FROM rides ORDER BY last_active DESC').toArray();
  }

  listUsers(): AdminUser[] {
    return this.sql
      .exec<UserRow & { friends: number; logs: number; email: string | null }>('SELECT u.*, c.email, (SELECT COUNT(*) FROM friendships f WHERE f.a = u.id OR f.b = u.id) AS friends, (SELECT COUNT(*) FROM ride_logs l WHERE l.user_id = u.id) AS logs FROM users u LEFT JOIN credentials c ON c.user_id = u.id ORDER BY u.last_seen DESC')
      .toArray()
      .map((u) => ({ ...toFriend(u), email: u.email ?? '', createdAt: u.created_at, lastSeen: u.last_seen, blocked: !!u.blocked, friends: u.friends, ridesLogged: u.logs }));
  }

  counts(): { friendships: number } {
    return { friendships: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM friendships').one().n };
  }

  setBlocked(id: string, blocked: boolean): void {
    this.sql.exec('UPDATE users SET blocked = ? WHERE id = ?', blocked ? 1 : 0, id);
    if (blocked) this.endSessions(id);
  }

  deleteUser(id: string): void {
    this.sql.exec('DELETE FROM users WHERE id = ?', id);
    this.sql.exec('DELETE FROM credentials WHERE user_id = ?', id);
    this.endSessions(id);
    this.sql.exec('DELETE FROM friendships WHERE a = ? OR b = ?', id, id);
    this.sql.exec('DELETE FROM requests WHERE from_id = ? OR to_id = ?', id, id);
    this.sql.exec('DELETE FROM invites WHERE from_id = ? OR to_id = ?', id, id);
    this.sql.exec('DELETE FROM ride_logs WHERE user_id = ?', id);
  }
}

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
